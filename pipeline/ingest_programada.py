"""Ingestão incremental da carga programada ONS (semi-horária) → load_official_forecast horária no Supabase."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta, timezone

import pandas as pd
import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values

API_URL = "https://apicarga.ons.org.br/prd/cargaprogramada"
SUBSYSTEMS = ["SECO"]
DEFAULT_LOOKBACK_DAYS = 10
BRASILIA = timezone(timedelta(hours=-3))

load_dotenv()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingestão da carga programada ONS para load_official_forecast."
    )
    parser.add_argument(
        "--inicio",
        type=date.fromisoformat,
        help="Data inicial inclusive (YYYY-MM-DD). Padrão: hoje − 10 dias.",
    )
    parser.add_argument(
        "--fim",
        type=date.fromisoformat,
        help="Data final inclusive (YYYY-MM-DD). Padrão: hoje.",
    )
    return parser.parse_args()


def default_date_window() -> tuple[date, date]:
    fim = date.today()
    inicio = fim - timedelta(days=DEFAULT_LOOKBACK_DAYS)
    return inicio, fim


def fetch_programada(cod_areacarga: str, inicio: date, fim: date) -> list[dict] | None:
    params = {
        "dat_inicio": inicio.isoformat(),
        "dat_fim": fim.isoformat(),
        "cod_areacarga": cod_areacarga,
    }
    try:
        response = requests.get(API_URL, params=params, timeout=60)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"[{cod_areacarga}] Erro HTTP: {exc}", file=sys.stderr)
        return None

    data = response.json()
    if not isinstance(data, list):
        print(f"[{cod_areacarga}] Resposta inesperada (não é lista).", file=sys.stderr)
        return None
    if not data:
        print(f"[{cod_areacarga}] Resposta vazia para {inicio}..{fim}.", file=sys.stderr)
        return None
    return data


def semi_hourly_to_hour_label(din_referenciautc: str) -> pd.Timestamp:
    fim_utc = pd.to_datetime(din_referenciautc, utc=True)
    fim_brasilia = fim_utc.tz_convert(BRASILIA)
    inicio = fim_brasilia - pd.Timedelta(minutes=30)
    return inicio.floor("h")


def aggregate_hourly(records: list[dict]) -> pd.DataFrame:
    rows = []
    for record in records:
        rows.append(
            {
                "hora_ts": semi_hourly_to_hour_label(record["din_referenciautc"]),
                "val_cargaglobalprogramada": record["val_cargaglobalprogramada"],
            }
        )

    df = pd.DataFrame(rows)
    df = df[
        df["val_cargaglobalprogramada"].notna()
        & (df["val_cargaglobalprogramada"] != 0)
    ]
    hourly = (
        df.groupby("hora_ts", as_index=False)
        .agg(load_mw=("val_cargaglobalprogramada", "mean"))
        .sort_values("hora_ts")
    )
    return hourly


def load_subsystem_ids(conn, codigos: list[str]) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT codigo, id FROM subsystems WHERE codigo = ANY(%s)",
            (codigos,),
        )
        mapping = {row[0]: row[1] for row in cur.fetchall()}

    missing = [c for c in codigos if c not in mapping]
    if missing:
        raise RuntimeError(f"Subsistemas não encontrados em subsystems: {missing}")

    return mapping


def upsert_load_official_forecast(
    conn,
    subsystem_id: int,
    hourly: pd.DataFrame,
) -> int:
    if hourly.empty:
        return 0

    rows = [
        (
            subsystem_id,
            row.hora_ts.to_pydatetime(),
            float(row.load_mw),
        )
        for row in hourly.itertuples(index=False)
    ]

    sql = """
        INSERT INTO load_official_forecast (subsystem_id, ts, load_mw)
        VALUES %s
        ON CONFLICT (subsystem_id, ts) DO UPDATE SET
            load_mw = EXCLUDED.load_mw
        RETURNING 1
    """
    with conn.cursor() as cur:
        result = execute_values(cur, sql, rows, fetch=True)
        return len(result)


def main() -> None:
    args = parse_args()
    inicio, fim = default_date_window()
    if args.inicio is not None:
        inicio = args.inicio
    if args.fim is not None:
        fim = args.fim

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL não definida.", file=sys.stderr)
        sys.exit(1)

    conn = None
    try:
        conn = psycopg2.connect(database_url)
        subsystem_ids = load_subsystem_ids(conn, SUBSYSTEMS)

        print(f"Janela: {inicio.isoformat()} .. {fim.isoformat()} (inclusiva)")

        for codigo in SUBSYSTEMS:
            records = fetch_programada(codigo, inicio, fim)
            if records is None:
                continue

            hourly = aggregate_hourly(records)
            upserted = upsert_load_official_forecast(conn, subsystem_ids[codigo], hourly)

            print(
                f"[{codigo}] semi-horários={len(records)} | "
                f"horas={len(hourly)} | upsert={upserted}"
            )

        conn.commit()
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    main()
