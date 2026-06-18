"""Sensibilidade da carga à temperatura (OLS por ponto de equilíbrio, diário)."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import holidays
import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json
from scipy.optimize import lsq_linear

from src.ingest import BRASILIA  # convenção de fuso (UTC−3)

SOURCE = "open-meteo-era5 + load_actual (OLS ponto de equilíbrio, diário)"
MIN_HOURS_PER_DAY = 20  # descarta dias parciais
MIN_DAYS_PER_BIN = 3  # bins ralos não entram na curva
MIN_DAYS = 60  # piso para um ajuste minimamente confiável

load_dotenv()


def load_subsystems(conn, codigos: list[str] | None) -> list[dict]:
    with conn.cursor() as cur:
        if codigos:
            cur.execute(
                "SELECT id, codigo FROM subsystems WHERE codigo = ANY(%s) ORDER BY id",
                (codigos,),
            )
        else:
            cur.execute("SELECT id, codigo FROM subsystems ORDER BY id")
        rows = cur.fetchall()
    if codigos:
        found = {r[1] for r in rows}
        missing = [c for c in codigos if c not in found]
        if missing:
            raise RuntimeError(f"Subsistemas não encontrados em subsystems: {missing}")
    return [{"id": r[0], "codigo": r[1]} for r in rows]


def load_daily(conn, subsystem_id: int) -> pd.DataFrame:
    """Carga × temperatura horárias (inner join por ts) → agregado diário (Brasília)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT la.ts, la.load_mw, w.temp_c
            FROM load_actual la
            JOIN weather_actual w
              ON w.subsystem_id = la.subsystem_id AND w.ts = la.ts
            WHERE la.subsystem_id = %s
            ORDER BY la.ts
            """,
            (subsystem_id,),
        )
        rows = cur.fetchall()

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows, columns=["ts", "load_mw", "temp_c"])
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.tz_convert(BRASILIA)
    df["data"] = df["ts"].dt.date
    df["load_mw"] = df["load_mw"].astype(float)
    df["temp_c"] = df["temp_c"].astype(float)

    daily = (
        df.groupby("data")
        .agg(
            load_mw=("load_mw", "mean"),
            temp_c=("temp_c", "mean"),
            n_horas=("load_mw", "size"),
        )
        .reset_index()
    )
    daily = daily[daily["n_horas"] >= MIN_HOURS_PER_DAY].reset_index(drop=True)
    if daily.empty:
        return daily

    # is_offday: sábado/domingo OU feriado nacional BR.
    anos = range(daily["data"].min().year, daily["data"].max().year + 1)
    br = holidays.country_holidays("BR", years=anos)
    daily["is_offday"] = [
        1 if (d.weekday() >= 5 or d in br) else 0 for d in daily["data"]
    ]
    return daily


def fit_balance_point(daily: pd.DataFrame) -> dict:
    """Busca em grade o T_eq que maximiza o R².

    Mínimos quadrados com restrição de não-negatividade nas duas inclinações de
    temperatura (cool ≥ 0, heat ≥ 0); dummy de fim de semana/feriado e intercepto
    livres. Resolve via scipy.optimize.lsq_linear.
    """
    t = daily["temp_c"].to_numpy()
    y = daily["load_mw"].to_numpy()
    off = daily["is_offday"].to_numpy(dtype=float)
    ones = np.ones_like(t)

    ss_tot = float(np.sum((y - y.mean()) ** 2))

    lo = np.floor(np.quantile(t, 0.1))
    hi = np.ceil(np.quantile(t, 0.9))
    candidates = np.arange(lo, hi + 0.5, 0.5)

    # [slope_cool, slope_heat, dummy, intercepto] — só as inclinações são ≥ 0.
    lb = [0.0, 0.0, -np.inf, -np.inf]
    ub = [np.inf, np.inf, np.inf, np.inf]

    best = None
    for b in candidates:
        cool = np.maximum(t - b, 0.0)
        heat = np.maximum(b - t, 0.0)
        A = np.column_stack([cool, heat, off, ones])
        beta = lsq_linear(A, y, bounds=(lb, ub)).x
        yhat = A @ beta
        ss_res = float(np.sum((y - yhat) ** 2))
        r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
        if best is None or r2 > best["r2"]:
            best = {"b": float(b), "beta": beta, "r2": float(r2)}

    beta = best["beta"]
    return {
        "balance_c": best["b"],
        "slope_cool": float(beta[0]),
        "slope_heat": float(beta[1]),
        "intercept": float(beta[3]),
        "r2": best["r2"],
        "n_days": int(len(daily)),
        "mean_load_mw": float(y.mean()),  # média da carga diária no mesmo conjunto de dias
        "beta": beta,
    }


def build_curve(daily: pd.DataFrame, res: dict) -> list[dict]:
    """Por bin de 1 °C: carga média observada, nº de dias e ajuste (dia útil típico)."""
    binned = daily.copy()
    binned["temp_bin"] = np.round(binned["temp_c"]).astype(int)
    grp = (
        binned.groupby("temp_bin")
        .agg(observed=("load_mw", "mean"), n=("load_mw", "size"))
        .reset_index()
    )
    grp = grp[grp["n"] >= MIN_DAYS_PER_BIN].sort_values("temp_bin")

    b = res["balance_c"]
    beta = res["beta"]
    curve = []
    for row in grp.itertuples(index=False):
        c = float(row.temp_bin)
        cool = max(c - b, 0.0)
        heat = max(b - c, 0.0)
        # is_offday = 0 (dia útil típico): fitted = cool·β0 + heat·β1 + intercepto·β3.
        fitted = float(beta[0] * cool + beta[1] * heat + beta[3])
        curve.append(
            {
                "temp": int(row.temp_bin),
                "observed": round(float(row.observed), 1),
                "fitted": round(fitted, 1),
                "n": int(row.n),
            }
        )
    return curve


def upsert_sensitivity(
    conn, subsystem_id: int, res: dict, curve: list[dict], computed_at: datetime
) -> None:
    sql = """
        INSERT INTO weather_sensitivity
            (subsystem_id, balance_c, slope_cool_mw_per_c, slope_heat_mw_per_c,
             intercept_mw, r2, n_days, mean_load_mw, curve, computed_at, source)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (subsystem_id) DO UPDATE SET
            balance_c           = EXCLUDED.balance_c,
            slope_cool_mw_per_c = EXCLUDED.slope_cool_mw_per_c,
            slope_heat_mw_per_c = EXCLUDED.slope_heat_mw_per_c,
            intercept_mw        = EXCLUDED.intercept_mw,
            r2                  = EXCLUDED.r2,
            n_days              = EXCLUDED.n_days,
            mean_load_mw        = EXCLUDED.mean_load_mw,
            curve               = EXCLUDED.curve,
            computed_at         = EXCLUDED.computed_at,
            source              = EXCLUDED.source
    """
    with conn.cursor() as cur:
        cur.execute(
            sql,
            (
                subsystem_id,
                res["balance_c"],
                res["slope_cool"],
                res["slope_heat"],
                res["intercept"],
                res["r2"],
                res["n_days"],
                res["mean_load_mw"],
                Json(curve),
                computed_at,
                SOURCE,
            ),
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sensibilidade carga × temperatura (OLS ponto de equilíbrio) → weather_sensitivity."
    )
    parser.add_argument(
        "--codigo",
        help="Subsistema (SECO|S|NE|N). Ausente: roda os 4.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL não definida.", file=sys.stderr)
        sys.exit(1)

    codigos = [args.codigo] if args.codigo else None

    conn = None
    try:
        conn = psycopg2.connect(database_url)
        subs = load_subsystems(conn, codigos)
        print(f"Subsistemas: {[s['codigo'] for s in subs]}")
        print(
            f"{'codigo':<7}{'balance_c':>11}{'slope_cool':>12}"
            f"{'slope_heat':>12}{'r2':>8}{'n_days':>8}{'mean_load':>12}"
        )
        print("-" * 70)

        for sub in subs:
            daily = load_daily(conn, sub["id"])
            if len(daily) < MIN_DAYS:
                print(
                    f"{sub['codigo']:<7} dados insuficientes "
                    f"({len(daily)} dias < {MIN_DAYS}) — pulando",
                    file=sys.stderr,
                )
                continue

            res = fit_balance_point(daily)
            curve = build_curve(daily, res)
            upsert_sensitivity(
                conn, sub["id"], res, curve, datetime.now(timezone.utc)
            )
            conn.commit()  # 1 linha por subsistema

            print(
                f"{sub['codigo']:<7}{res['balance_c']:>11.1f}"
                f"{res['slope_cool']:>12.1f}{res['slope_heat']:>12.1f}"
                f"{res['r2']:>8.3f}{res['n_days']:>8}{res['mean_load_mw']:>12.0f}"
            )
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    main()
