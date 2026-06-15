"""Backtest walk-forward do subsistema SECO: Ridge × ingênuo sazonal × programada ONS.

PRIORIDADE ABSOLUTA: zero vazamento. Toda feature de carga respeita o PISO DE 24h —
para prever a hora-alvo t, nenhuma feature toca dado no intervalo (t−24h, t]; só t−24h
ou antes. O calendário é determinístico (não vaza). Nada é normalizado sobre o dataset
inteiro: o StandardScaler é reajustado no treino de CADA origem.

Walk-forward day-ahead, janela EXPANSÍVEL, re-treino mensal:
  - corte inicial: treino 2024-06-01..2025-05-31, teste a partir de 2025-06-01;
  - origens de re-treino = início de cada mês do teste;
  - em cada origem O treina com alvos ESTRITAMENTE < O (assim nenhuma hora prevista é
    vista no treino — o spec dizia "alvo <= O", mas isso colocaria a própria hora O em
    treino e teste; cortar em < O elimina essa sobreposição de 1h) e prevê [O, próxima O).

Grava model_runs (1), predictions (ridge) e evaluations (ridge/naive/ons × mape/mae/rmse).
Idempotente: remove qualquer run "ridge_v1" anterior (e seus filhos) antes de inserir.

Uso: python pipeline/model.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import holidays
import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BRASILIA = timezone(timedelta(hours=-3))
CODIGO = "SECO"
MODEL_NAME = "ridge_v1"
RIDGE_ALPHA = 1.0
HORIZON_H = 24

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

    anos = range(idx.year.min() - 1, idx.year.max() + 2)
    br = holidays.country_holidays("BR", years=anos)
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
# Walk-forward
# ---------------------------------------------------------------------------
def month_origins(start: pd.Timestamp, end: pd.Timestamp) -> list[pd.Timestamp]:
    origins = []
    o = start
    while o <= end:
        origins.append(o)
        o = o + pd.DateOffset(months=1)
    return origins


def walk_forward(X: pd.DataFrame, y: pd.Series) -> pd.Series:
    """Treina/prevê por origem mensal. Retorna ŷ do ridge indexado por hora-alvo."""
    valid = X.notna().all(axis=1) & y.notna()
    origins = month_origins(TEST_START, y.index.max())
    preds = pd.Series(index=y.index, dtype=float)

    for i, o in enumerate(origins):
        next_o = origins[i + 1] if i + 1 < len(origins) else y.index.max() + pd.Timedelta(hours=1)

        # Treino: alvos ESTRITAMENTE antes de O (nenhuma hora prevista entra no treino)
        train_mask = valid & (y.index < o)
        # Teste: [O, próxima origem)
        test_mask = valid & (y.index >= o) & (y.index < next_o)
        if train_mask.sum() == 0 or test_mask.sum() == 0:
            continue

        model = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA))
        model.fit(X.loc[train_mask].to_numpy(), y.loc[train_mask].to_numpy())
        preds.loc[test_mask] = model.predict(X.loc[test_mask].to_numpy())

    return preds


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


def persist(
    conn,
    sub_id: int,
    hyperparams: dict,
    train_end: pd.Timestamp,
    ridge_pred: pd.Series,
    evals: dict[str, dict[str, float]],
) -> int:
    with conn.cursor() as cur:
        # Idempotência: apaga runs anteriores deste model_name (e filhos)
        cur.execute("SELECT id FROM model_runs WHERE model_name = %s", (MODEL_NAME,))
        old = [r[0] for r in cur.fetchall()]
        if old:
            cur.execute("DELETE FROM evaluations WHERE model_run_id = ANY(%s)", (old,))
            cur.execute("DELETE FROM predictions WHERE model_run_id = ANY(%s)", (old,))
            cur.execute("DELETE FROM model_runs WHERE id = ANY(%s)", (old,))

        cur.execute(
            """
            INSERT INTO model_runs
                (model_name, trained_at, hyperparams, artifact, git_commit, train_start, train_end)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                MODEL_NAME,
                datetime.now(BRASILIA),
                Json(hyperparams),
                None,  # artifact null por enquanto (Ridge servido vem depois)
                git_commit(),
                TRAIN_START.date(),
                train_end.date(),
            ),
        )
        model_run_id = int(cur.fetchone()[0])

        pred_rows = [
            (model_run_id, sub_id, ts.to_pydatetime(), float(v))
            for ts, v in ridge_pred.dropna().items()
        ]
        execute_values(
            cur,
            "INSERT INTO predictions (model_run_id, subsystem_id, target_ts, predicted_mw) VALUES %s",
            pred_rows,
        )

        eval_rows = [
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
            eval_rows,
        )

    conn.commit()
    return model_run_id


# ---------------------------------------------------------------------------
# Relatório
# ---------------------------------------------------------------------------
def report(evals: dict, n: int, t0: pd.Timestamp, t1: pd.Timestamp) -> None:
    print()
    print(f"Teste: {n} horas | {t0} .. {t1} (Brasília) | horizonte {HORIZON_H}h")
    print(f"{'predictor':<10}{'MAPE %':>10}{'MAE MWmed':>14}{'RMSE MWmed':>14}")
    print("-" * 48)
    for p in ("ridge", "naive", "ons"):
        m = evals[p]
        print(f"{p:<10}{m['mape']:>10.2f}{m['mae']:>14.1f}{m['rmse']:>14.1f}")
    print()
    for base in ("naive", "ons"):
        for metric in ("mape", "mae", "rmse"):
            b = evals[base][metric]
            r = evals["ridge"][metric]
            skill = (b - r) / b * 100 if b else float("nan")
            print(f"skill ridge vs {base:<5} ({metric.upper()}): {skill:+.1f}% redução de erro")
        print()


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL não definida.", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(database_url)
    try:
        sub_id = subsystem_id(conn, CODIGO)
        actual_raw = fetch_series(conn, "load_actual", CODIGO)
        prog_raw = fetch_series(conn, "load_official_forecast", CODIGO)

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

        ridge_pred = walk_forward(X, y)

        # Conjunto de teste: horas onde os 4 existem (verificada, ridge, naive, ons)
        test_df = pd.DataFrame(
            {
                "actual": y,
                "ridge": ridge_pred,
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
            "naive": metrics(a, test_df["naive"].to_numpy()),
            "ons": metrics(a, test_df["ons"].to_numpy()),
        }

        n = len(test_df)
        t0, t1 = test_df.index.min(), test_df.index.max()

        hyperparams = {
            "alpha": RIDGE_ALPHA,
            "features": FEATURES,
            "leakage_floor_h": 24,
            "walk_forward": "expanding, monthly retrain",
            "train_cut": "target < origin (estritamente)",
            "initial_train": [str(TRAIN_START.date()), str(INITIAL_TRAIN_END.date())],
            "test_start": str(TEST_START.date()),
            "n_test_hours": n,
        }
        # train_end = última origem usada (último corte de treino do walk-forward)
        train_end = month_origins(TEST_START, y.index.max())[-1]

        model_run_id = persist(conn, sub_id, hyperparams, train_end, ridge_pred, evals)

        report(evals, n, t0, t1)
        print(
            f"Gravado: model_run_id={model_run_id} | "
            f"predictions={ridge_pred.dropna().shape[0]} | evaluations=9 linhas"
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
