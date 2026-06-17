"""Treino e teste retroativo dos modelos de carga por subsistema.

Backtest walk-forward de Ridge e LightGBM contra os baselines (ingênuo sazonal
e programada ONS); grava model_runs, predictions, evaluations e o artifact do
Ridge servido para a /api/forecast. Método detalhado nos comentários de seção
e no README.

Uso: python pipeline/src/model.py
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import warnings
from datetime import datetime, timedelta, timezone
from typing import Callable

warnings.filterwarnings("ignore", message="X does not have valid feature names")

import holidays
import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from lightgbm import LGBMRegressor
from psycopg2.extras import Json, execute_values
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BRASILIA = timezone(timedelta(hours=-3))
DEFAULT_CODIGO = "SECO"
HORIZON_H = 24

RIDGE_BASE = "ridge_v1"
LGBM_BASE = "lgbm_v1"
SERVED_BASE = "ridge_v1_served"

PARITY_CODIGO = "SECO"

RIDGE_ALPHA = 1.0
LGBM_PARAMS = {
    "n_estimators": 400,
    "learning_rate": 0.05,
    "num_leaves": 31,
    "subsample": 0.8,
    "subsample_freq": 1,
    "colsample_bytree": 0.8,
    "random_state": 42,
    "n_jobs": -1,
    "verbosity": -1,
}

TRAIN_START = pd.Timestamp("2024-06-01 00:00", tz=BRASILIA)
INITIAL_TRAIN_END = pd.Timestamp("2025-05-31 23:00", tz=BRASILIA)
TEST_START = pd.Timestamp("2025-06-01 00:00", tz=BRASILIA)

LOAD_FEATURES = [
    "lag_24",
    "lag_48",
    "lag_168",
    "roll_mean_24",
    "roll_std_24",
    "roll_mean_7d",
    "roll_std_7d",
    "same_hour_mean_7d",
]
CALENDAR_FEATURES = [
    "hour",
    "dow",
    "month",
    "is_weekend",
    "is_holiday",
    "is_pre_holiday",
]
FOURIER_FEATURES = [
    "sin_hour",
    "cos_hour",
    "sin_dow",
    "cos_dow",
    "sin_doy",
    "cos_doy",
]
FEATURES = LOAD_FEATURES + CALENDAR_FEATURES + FOURIER_FEATURES

load_dotenv()


# ---------------------------------------------------------------------------
# Dados
# ---------------------------------------------------------------------------
def fetch_series(conn, table: str, codigo: str) -> pd.Series:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT t.ts, t.load_mw
            FROM {table} t
            JOIN subsystems s ON s.id = t.subsystem_id
            WHERE s.codigo = %s
            ORDER BY t.ts
            """,
            (codigo,),
        )
        rows = cur.fetchall()
    if not rows:
        raise RuntimeError(f"Sem dados em {table} para {codigo}.")
    idx = pd.DatetimeIndex([r[0] for r in rows])  # tz-aware UTC
    vals = [float(r[1]) for r in rows]
    return pd.Series(vals, index=idx, name="load_mw").tz_convert(BRASILIA)


def to_continuous_hourly(s: pd.Series, full_idx: pd.DatetimeIndex) -> pd.Series:
    """Reindexa para índice horário contínuo (gaps viram NaN, explícitos)."""
    s = s[~s.index.duplicated(keep="last")]
    return s.reindex(full_idx)


def subsystem_id(conn, codigo: str) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM subsystems WHERE codigo = %s", (codigo,))
        row = cur.fetchone()
    if row is None:
        raise RuntimeError(f"Subsistema {codigo} não encontrado.")
    return int(row[0])


def br_holidays_for_index(idx: pd.DatetimeIndex):
    """Feriados nacionais BR cobrindo os anos do índice (+1 de buffer p/ véspera/virada)."""
    anos = range(idx.year.min() - 1, idx.year.max() + 2)
    return holidays.country_holidays("BR", years=anos)


# ---------------------------------------------------------------------------
# Features — PISO DE 24h em toda feature de carga
# ---------------------------------------------------------------------------
def build_features(actual: pd.Series) -> pd.DataFrame:
    idx = actual.index
    base = actual.shift(24)  # tudo termina em t−24h

    feat = pd.DataFrame(index=idx)

    # Lags (>= 24h)
    feat["lag_24"] = actual.shift(24)
    feat["lag_48"] = actual.shift(48)
    feat["lag_168"] = actual.shift(168)

    # Móveis terminando em t−24h (janelas estritamente <= t−24h)
    feat["roll_mean_24"] = base.rolling(24, min_periods=24).mean()
    feat["roll_std_24"] = base.rolling(24, min_periods=24).std()
    feat["roll_mean_7d"] = base.rolling(168, min_periods=168).mean()
    feat["roll_std_7d"] = base.rolling(168, min_periods=168).std()

    # Mesma hora-do-dia nos últimos 7 dias (offsets 24,48,...,168 — todos >= 24h)
    same_hour = pd.concat([actual.shift(24 * k) for k in range(1, 8)], axis=1)
    feat["same_hour_mean_7d"] = same_hour.mean(axis=1)

    # Calendário determinístico (não vaza)
    feat["hour"] = idx.hour
    feat["dow"] = idx.dayofweek
    feat["month"] = idx.month
    feat["is_weekend"] = (idx.dayofweek >= 5).astype(int)

    br = br_holidays_for_index(idx)
    dias = idx.normalize()
    feat["is_holiday"] = [1 if d.date() in br else 0 for d in dias]
    feat["is_pre_holiday"] = [
        1 if (d.date() + timedelta(days=1)) in br else 0 for d in dias
    ]

    # Fourier
    feat["sin_hour"] = np.sin(2 * np.pi * idx.hour / 24)
    feat["cos_hour"] = np.cos(2 * np.pi * idx.hour / 24)
    feat["sin_dow"] = np.sin(2 * np.pi * idx.dayofweek / 7)
    feat["cos_dow"] = np.cos(2 * np.pi * idx.dayofweek / 7)
    feat["sin_doy"] = np.sin(2 * np.pi * idx.dayofyear / 365)
    feat["cos_doy"] = np.cos(2 * np.pi * idx.dayofyear / 365)

    return feat[FEATURES]


# ---------------------------------------------------------------------------
# Walk-forward day-ahead: origens mensais, janela expansível, treino com alvos
# estritamente < O (origem). Mesmo `valid` p/ todos os estimadores → mesmas horas.
# ---------------------------------------------------------------------------
def make_ridge():
    return make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA))


def make_lgbm():
    # LightGBM usa as features cruas: sem scaling, NaN nativo (aqui já filtrados por `valid`).
    return LGBMRegressor(**LGBM_PARAMS)


def month_origins(start: pd.Timestamp, end: pd.Timestamp) -> list[pd.Timestamp]:
    origins = []
    o = start
    while o <= end:
        origins.append(o)
        o = o + pd.DateOffset(months=1)
    return origins


def walk_forward(
    X: pd.DataFrame,
    y: pd.Series,
    make_model: Callable,
) -> pd.Series:
    """Treina/prevê por origem mensal. Mesmo `valid` p/ todos os estimadores → mesmas horas."""
    valid = X.notna().all(axis=1) & y.notna()
    origins = month_origins(TEST_START, y.index.max())
    preds = pd.Series(index=y.index, dtype=float)

    for i, o in enumerate(origins):
        next_o = (
            origins[i + 1]
            if i + 1 < len(origins)
            else y.index.max() + pd.Timedelta(hours=1)
        )
        train_mask = valid & (y.index < o)  # alvos estritamente antes de O
        test_mask = valid & (y.index >= o) & (y.index < next_o)
        if train_mask.sum() == 0 or test_mask.sum() == 0:
            continue

        model = make_model()
        model.fit(X.loc[train_mask].to_numpy(), y.loc[train_mask].to_numpy())
        preds.loc[test_mask] = model.predict(X.loc[test_mask].to_numpy())

    return preds


# ---------------------------------------------------------------------------
# Ridge servido — treino em TODO o histórico, artifact JSON p/ inferência em TS
# ---------------------------------------------------------------------------
def fit_served_ridge(
    X: pd.DataFrame, y: pd.Series, codigo: str
) -> tuple[object, dict, pd.Timestamp, int]:
    valid = X.notna().all(axis=1) & y.notna()
    Xv = X.loc[valid]
    yv = y.loc[valid]

    pipe = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA))
    pipe.fit(Xv.to_numpy(), yv.to_numpy())

    scaler: StandardScaler = pipe.named_steps["standardscaler"]
    ridge: Ridge = pipe.named_steps["ridge"]

    artifact = {
        "model": "ridge",
        "alpha": RIDGE_ALPHA,
        "subsystem": codigo,
        "target": "load_mw",
        "horizon_h": HORIZON_H,
        "leakage_floor_h": 24,
        "features": FEATURES,  # ORDEM exata — a inferência TS deve montar x nesta ordem
        "scaler_mean": [float(v) for v in scaler.mean_],
        "scaler_scale": [float(v) for v in scaler.scale_],
        "coef": [float(v) for v in ridge.coef_],
        "intercept": float(ridge.intercept_),
        "formula": "yhat = intercept + sum_i coef_i * ((x_i - scaler_mean_i) / scaler_scale_i)",
        "trained_rows": int(valid.sum()),
        "train_start": str(yv.index.min().date()),
        "train_end": str(yv.index.max().date()),
    }
    return pipe, artifact, yv.index.max(), int(valid.sum())


# ---------------------------------------------------------------------------
# Casos de referência p/ paridade TS (emitidos junto do served ridge)
# ---------------------------------------------------------------------------
# Artefatos JSON ficam em pipeline/data/ (este módulo vive em pipeline/src/).
DATA_DIR = pathlib.Path(__file__).resolve().parent.parent / "data"


def build_history_for_target(actual: pd.Series, t: pd.Timestamp) -> dict[str, float]:
    """Histórico que a feature engineering precisa: offsets 24..191h antes de t.

    É a união exata do que as 20 features de carga enxergam (lags 24/48/168, médias/
    desvios móveis terminando em t−24h, mesma-hora-7d). Embutir isso torna o teste de
    paridade auto-contido — o TS recomputa as features só a partir daqui, sem DB nem Python.
    """
    hist = {}
    for off in range(24, 192):
        ts = t - pd.Timedelta(hours=off)
        hist[ts.isoformat()] = float(actual.loc[ts])
    return hist


def select_parity_targets(X: pd.DataFrame, actual: pd.Series) -> list[tuple[str, pd.Timestamp]]:
    """~10 horas-alvo variadas (madrugada/pico, útil/fim de semana, feriado e véspera)."""
    valid = X.notna().all(axis=1) & actual.notna()
    idx = X.index[valid]
    idx = idx[idx >= TEST_START]
    feat = X.loc[idx]

    def first(mask: pd.Series):
        sel = idx[mask.to_numpy()]
        return sel[0] if len(sel) else None

    candidates = [
        ("weekday_dawn", (feat.hour == 3) & (feat.is_weekend == 0)),
        ("weekday_peak", (feat.hour == 19) & (feat.is_weekend == 0)),
        ("weekend_dawn", (feat.hour == 3) & (feat.is_weekend == 1)),
        ("weekend_peak", (feat.hour == 19) & (feat.is_weekend == 1)),
        ("pre_holiday", feat.is_pre_holiday == 1),
        ("holiday", feat.is_holiday == 1),
        ("midday_aug", (feat.hour == 12) & (feat.month == 8)),
        ("evening_nov", (feat.hour == 21) & (feat.month == 11)),
        ("morning_jan", (feat.hour == 7) & (feat.month == 1)),
        ("midnight_mar", (feat.hour == 0) & (feat.month == 3)),
    ]
    out: list[tuple[str, pd.Timestamp]] = []
    seen: set = set()
    for label, mask in candidates:
        t = first(mask)
        if t is not None and t not in seen:
            seen.add(t)
            out.append((label, t))
    return out


def emit_reference_files(
    X: pd.DataFrame, actual: pd.Series, pipe, artifact: dict
) -> tuple[int, int]:
    targets = select_parity_targets(X, actual)
    cases = []
    for label, t in targets:
        feats = [float(v) for v in X.loc[t].to_numpy()]  # já na ORDEM de FEATURES/artifact
        yhat = float(pipe.predict(X.loc[[t]].to_numpy())[0])
        cases.append(
            {
                "label": label,
                "target_ts": t.isoformat(),
                "features": feats,
                "yhat": yhat,
                "history": build_history_for_target(actual, t),
            }
        )
    parity = {
        "artifact": artifact,
        "feature_order": artifact["features"],
        "cases": cases,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "parity_cases.json").write_text(
        json.dumps(parity, indent=2), encoding="utf-8"
    )

    br = br_holidays_for_index(actual.index)
    dates = sorted(d.isoformat() for d in br.keys())
    (DATA_DIR / "holidays_br.json").write_text(
        json.dumps(dates, indent=2), encoding="utf-8"
    )
    return len(cases), len(dates)


# ---------------------------------------------------------------------------
# Métricas
# ---------------------------------------------------------------------------
def metrics(actual: np.ndarray, pred: np.ndarray) -> dict[str, float]:
    erro = pred - actual
    return {
        "mape": float(np.mean(np.abs(erro) / actual) * 100),
        "mae": float(np.mean(np.abs(erro))),
        "rmse": float(np.sqrt(np.mean(erro**2))),
    }


# ---------------------------------------------------------------------------
# Gravação
# ---------------------------------------------------------------------------
def git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def insert_run(
    cur,
    model_name: str,
    hyperparams: dict,
    artifact: dict | None,
    train_start,
    train_end,
    commit: str | None,
) -> int:
    cur.execute(
        """
        INSERT INTO model_runs
            (model_name, trained_at, hyperparams, artifact, git_commit, train_start, train_end)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            model_name,
            datetime.now(BRASILIA),
            Json(hyperparams),
            Json(artifact) if artifact is not None else None,
            commit,
            train_start,
            train_end,
        ),
    )
    return int(cur.fetchone()[0])


def insert_predictions(cur, model_run_id: int, sub_id: int, preds: pd.Series) -> int:
    rows = [
        (model_run_id, sub_id, ts.to_pydatetime(), float(v))
        for ts, v in preds.dropna().items()
    ]
    execute_values(
        cur,
        "INSERT INTO predictions (model_run_id, subsystem_id, target_ts, predicted_mw) VALUES %s",
        rows,
    )
    return len(rows)


def insert_evaluations(
    cur, model_run_id: int, sub_id: int, evals: dict[str, dict[str, float]]
) -> int:
    rows = [
        (model_run_id, sub_id, predictor, metric, value, HORIZON_H)
        for predictor, ms in evals.items()
        for metric, value in ms.items()
    ]
    execute_values(
        cur,
        """
        INSERT INTO evaluations
            (model_run_id, subsystem_id, predictor, metric, value, horizon_h)
        VALUES %s
        """,
        rows,
    )
    return len(rows)


def delete_prior_runs(cur, names: list[str]) -> None:
    cur.execute("SELECT id FROM model_runs WHERE model_name = ANY(%s)", (names,))
    old = [r[0] for r in cur.fetchall()]
    if old:
        cur.execute("DELETE FROM evaluations WHERE model_run_id = ANY(%s)", (old,))
        cur.execute("DELETE FROM predictions WHERE model_run_id = ANY(%s)", (old,))
        cur.execute("DELETE FROM model_runs WHERE id = ANY(%s)", (old,))


# ---------------------------------------------------------------------------
# Relatório
# ---------------------------------------------------------------------------
def report(
    evals: dict, n: int, t0: pd.Timestamp, t1: pd.Timestamp, artifact: dict, artifact_bytes: int
) -> None:
    print()
    print(f"Teste: {n} horas | {t0} .. {t1} (Brasília) | horizonte {HORIZON_H}h")
    print(f"{'predictor':<10}{'MAPE %':>10}{'MAE MWmed':>14}{'RMSE MWmed':>14}")
    print("-" * 48)
    for p in ("ridge", "lgbm", "naive", "ons"):
        m = evals[p]
        print(f"{p:<10}{m['mape']:>10.2f}{m['mae']:>14.1f}{m['rmse']:>14.1f}")
    print()
    for base in ("ridge", "naive", "ons"):
        for metric in ("mape", "mae", "rmse"):
            b = evals[base][metric]
            r = evals["lgbm"][metric]
            skill = (b - r) / b * 100 if b else float("nan")
            print(
                f"skill lgbm vs {base:<5} ({metric.upper()}): {skill:+.1f}% redução de erro"
            )
        print()
    print(
        f"Artifact do Ridge servido: {len(artifact['features'])} features | "
        f"{artifact_bytes} bytes (JSON) | treinado em {artifact['trained_rows']} horas "
        f"({artifact['train_start']}..{artifact['train_end']})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backtest walk-forward + Ridge servido, por subsistema."
    )
    parser.add_argument(
        "--codigo",
        default=DEFAULT_CODIGO,
        help="cod_areacarga do subsistema (padrão: SECO).",
    )
    args = parser.parse_args()
    codigo = args.codigo

    ridge_name = f"{RIDGE_BASE}_{codigo}"
    lgbm_name = f"{LGBM_BASE}_{codigo}"
    served_name = f"{SERVED_BASE}_{codigo}"

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL não definida.", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(database_url)
    try:
        sub_id = subsystem_id(conn, codigo)
        actual_raw = fetch_series(conn, "load_actual", codigo)
        prog_raw = fetch_series(conn, "load_official_forecast", codigo)

        full_idx = pd.date_range(
            actual_raw.index.min().floor("h"),
            actual_raw.index.max().floor("h"),
            freq="h",
            tz=BRASILIA,
        )
        actual = to_continuous_hourly(actual_raw, full_idx)
        programada = to_continuous_hourly(prog_raw, full_idx)

        X = build_features(actual)
        y = actual
        naive = actual.shift(168)

        # Mesmo protocolo, só o estimador muda
        ridge_pred = walk_forward(X, y, make_ridge)
        lgbm_pred = walk_forward(X, y, make_lgbm)

        # Conjunto de teste: horas com os 5 simultâneos (verificada, ridge, lgbm, naive, ons)
        test_df = pd.DataFrame(
            {
                "actual": y,
                "ridge": ridge_pred,
                "lgbm": lgbm_pred,
                "naive": naive,
                "ons": programada,
            }
        )
        test_df = test_df[test_df.index >= TEST_START].dropna()
        test_df = test_df[test_df["actual"] != 0]  # MAPE seguro
        if test_df.empty:
            print("Conjunto de teste vazio.", file=sys.stderr)
            sys.exit(1)

        a = test_df["actual"].to_numpy()
        evals = {
            "ridge": metrics(a, test_df["ridge"].to_numpy()),
            "lgbm": metrics(a, test_df["lgbm"].to_numpy()),
            "naive": metrics(a, test_df["naive"].to_numpy()),
            "ons": metrics(a, test_df["ons"].to_numpy()),
        }
        n = len(test_df)
        t0, t1 = test_df.index.min(), test_df.index.max()

        # Ridge servido (treino em todo o histórico)
        pipe_served, artifact, served_end, _ = fit_served_ridge(X, y, codigo)
        artifact_bytes = len(json.dumps(artifact))

        # Casos de referência + feriados p/ a paridade TS — só o subsistema de referência
        # (evita sobrescrever o parity_cases.json do SECO ao treinar outros subsistemas).
        if codigo == PARITY_CODIGO:
            n_cases, n_holidays = emit_reference_files(X, actual, pipe_served, artifact)
        else:
            n_cases, n_holidays = 0, 0

        commit = git_commit()
        train_end_bt = month_origins(TEST_START, y.index.max())[-1].date()

        ridge_hp = {
            "alpha": RIDGE_ALPHA,
            "features": FEATURES,
            "leakage_floor_h": 24,
            "walk_forward": "expanding, monthly retrain",
            "train_cut": "target < origin (estritamente)",
            "scaler": "StandardScaler reajustado por origem",
            "initial_train": [str(TRAIN_START.date()), str(INITIAL_TRAIN_END.date())],
            "test_start": str(TEST_START.date()),
            "n_test_hours": n,
        }
        lgbm_hp = {
            "estimator": "LGBMRegressor",
            "params": LGBM_PARAMS,
            "early_stopping": False,
            "features": FEATURES,
            "leakage_floor_h": 24,
            "walk_forward": "expanding, monthly retrain",
            "train_cut": "target < origin (estritamente)",
            "scaling": "none (LightGBM usa features cruas)",
            "test_start": str(TEST_START.date()),
            "n_test_hours": n,
        }
        served_hp = {
            "alpha": RIDGE_ALPHA,
            "features": FEATURES,
            "leakage_floor_h": 24,
            "training": "Ridge final em TODO o histórico (não é um Ridge do walk-forward)",
            "serves": "/api/forecast (inferência em TS)",
        }

        with conn.cursor() as cur:
            delete_prior_runs(cur, [ridge_name, lgbm_name, served_name])

            run_ridge = insert_run(
                cur, ridge_name, ridge_hp, None, TRAIN_START.date(), train_end_bt, commit
            )
            insert_predictions(cur, run_ridge, sub_id, ridge_pred)
            insert_evaluations(
                cur,
                run_ridge,
                sub_id,
                {"ridge": evals["ridge"], "naive": evals["naive"], "ons": evals["ons"]},
            )

            run_lgbm = insert_run(
                cur, lgbm_name, lgbm_hp, None, TRAIN_START.date(), train_end_bt, commit
            )
            insert_predictions(cur, run_lgbm, sub_id, lgbm_pred)
            insert_evaluations(cur, run_lgbm, sub_id, {"lgbm": evals["lgbm"]})

            run_served = insert_run(
                cur,
                served_name,
                served_hp,
                artifact,
                TRAIN_START.date(),
                served_end.date(),
                commit,
            )
        conn.commit()

        print(f"\n=== Subsistema {codigo} ===")
        report(evals, n, t0, t1, artifact, artifact_bytes)
        print(
            f"Gravado: {ridge_name}(run={run_ridge}, preds={ridge_pred.dropna().shape[0]}, evals=9) | "
            f"{lgbm_name}(run={run_lgbm}, preds={lgbm_pred.dropna().shape[0]}, evals=3) | "
            f"{served_name}(run={run_served}, artifact gravado)"
        )
        if n_cases:
            print(
                f"Referência p/ paridade TS: pipeline/data/parity_cases.json ({n_cases} casos) | "
                f"pipeline/data/holidays_br.json ({n_holidays} feriados)"
            )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
