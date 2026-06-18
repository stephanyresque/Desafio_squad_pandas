"""Ingestão de temperatura horária (Open-Meteo / ERA5) → weather_actual no Supabase."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values

from src.ingest import month_blocks  

BRASILIA = timezone(timedelta(hours=-3))  
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
SOURCE = "open-meteo-era5"
SAFETY_LAG_DAYS = 7  
LOOKBACK_DAYS = 730 

load_dotenv()


def default_date_window() -> tuple[date, date]:
    fim = date.today() - timedelta(days=SAFETY_LAG_DAYS)
    inicio = fim - timedelta(days=LOOKBACK_DAYS)
    return inicio, fim


def utc_to_brasilia_hour(time_utc: str) -> pd.Timestamp:
    """Hora UTC do Open-Meteo → hora-rótulo de Brasília (converte ao fuso e floor)."""
    return pd.to_datetime(time_utc, utc=True).tz_convert(BRASILIA).floor("h")


def fetch_weather(
    lat: float, lon: float, inicio: date, fim: date, codigo: str
) -> dict | None:
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": inicio.isoformat(),
        "end_date": fim.isoformat(),
        "hourly": "temperature_2m",
        "timezone": "UTC",
    }
    try:
        response = requests.get(ARCHIVE_URL, params=params, timeout=120)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"[weather/{codigo}] Erro HTTP: {exc}", file=sys.stderr)
        return None

    data = response.json()
    hourly = data.get("hourly")
    if not isinstance(hourly, dict) or not hourly.get("time"):
        print(
            f"[weather/{codigo}] Resposta vazia/inesperada para {inicio}..{fim}.",
            file=sys.stderr,
        )
        return None
    return data


def to_hourly(data: dict) -> pd.DataFrame:
    hourly = data["hourly"]
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []

    rows = [
        {"hora_ts": utc_to_brasilia_hour(t), "temp_c": v}
        for t, v in zip(times, temps)
        if v is not None  # descarta nulos — não inventa (0 °C é válido)
    ]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    # Já é 1 valor por hora (instantâneo): sem média — só dedup de segurança.
    return df.drop_duplicates("hora_ts", keep="last").sort_values("hora_ts")


def load_weather_points(conn, codigos: list[str] | None) -> list[dict]:
    with conn.cursor() as cur:
        if codigos:
            cur.execute(
                """
                SELECT id, codigo, weather_lat, weather_lon, weather_city
                FROM subsystems WHERE codigo = ANY(%s) ORDER BY id
                """,
                (codigos,),
            )
        else:
            cur.execute(
                """
                SELECT id, codigo, weather_lat, weather_lon, weather_city
                FROM subsystems ORDER BY id
                """
            )
        rows = cur.fetchall()

    if codigos:
        found = {r[1] for r in rows}
        missing = [c for c in codigos if c not in found]
        if missing:
            raise RuntimeError(f"Subsistemas não encontrados em subsystems: {missing}")

    sem_ponto = [r[1] for r in rows if r[2] is None or r[3] is None]
    if sem_ponto:
        raise RuntimeError(
            f"weather_lat/weather_lon nulos para {sem_ponto} "
            "— rode a migration 0002_weather.sql antes da ingestão."
        )

    return [
        {
            "id": r[0],
            "codigo": r[1],
            "weather_lat": float(r[2]),
            "weather_lon": float(r[3]),
            "weather_city": r[4],
        }
        for r in rows
    ]


def upsert_weather(
    conn, subsystem_id: int, hourly: pd.DataFrame, extracted_at: datetime
) -> int:
    if hourly.empty:
        return 0

    rows = [
        (
            subsystem_id,
            row.hora_ts.to_pydatetime(),
            float(row.temp_c),
            SOURCE,
            extracted_at,
        )
        for row in hourly.itertuples(index=False)
    ]
    sql = """
        INSERT INTO weather_actual (subsystem_id, ts, temp_c, source, extracted_at)
        VALUES %s
        ON CONFLICT (subsystem_id, ts) DO UPDATE SET
            temp_c = EXCLUDED.temp_c,
            source = EXCLUDED.source,
            extracted_at = EXCLUDED.extracted_at
        RETURNING 1
    """
    with conn.cursor() as cur:
        result = execute_values(cur, sql, rows, fetch=True)
        return len(result)


def run(conn, sub: dict, inicio: date, fim: date) -> None:
    """Varre [inicio, fim] em blocos mensais, com upsert (e commit) por bloco."""
    codigo = sub["codigo"]
    print(
        f"[weather/{codigo}] {sub['weather_city']} "
        f"({sub['weather_lat']}, {sub['weather_lon']}) | "
        f"janela total: {inicio} .. {fim} (inclusiva)"
    )

    total_horas = 0
    total_upsert = 0
    blocos_com_dado = 0
    blocos_vazios = 0

    for bloco_inicio, bloco_fim in month_blocks(inicio, fim):
        data = fetch_weather(
            sub["weather_lat"], sub["weather_lon"], bloco_inicio, bloco_fim, codigo
        )
        if data is None:
            blocos_vazios += 1
            print(f"  {bloco_inicio}..{bloco_fim}: sem dado, segue")
            continue

        hourly = to_hourly(data)
        upserted = upsert_weather(
            conn, sub["id"], hourly, datetime.now(timezone.utc)
        )
        conn.commit()  # checkpoint por bloco — backfill retomável

        total_horas += len(hourly)
        total_upsert += upserted
        blocos_com_dado += 1
        print(f"  {bloco_inicio}..{bloco_fim}: horas={len(hourly)} | upsert={upserted}")

    print(
        f"[weather/{codigo}] FIM: horas={total_horas} | upsert={total_upsert} | "
        f"blocos com dado={blocos_com_dado} | blocos vazios={blocos_vazios}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingestão de temperatura Open-Meteo (ERA5) → weather_actual, blocos mensais."
    )
    parser.add_argument(
        "--codigo",
        help="Subsistema (SECO|S|NE|N). Ausente: roda os 4.",
    )
    parser.add_argument(
        "--inicio",
        type=date.fromisoformat,
        help="Data inicial inclusive (YYYY-MM-DD). Padrão: fim − 730 dias.",
    )
    parser.add_argument(
        "--fim",
        type=date.fromisoformat,
        help="Data final inclusive (YYYY-MM-DD). Padrão: hoje − 7 dias.",
    )
    return parser.parse_args()


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

    codigos = [args.codigo] if args.codigo else None

    conn = None
    try:
        conn = psycopg2.connect(database_url)
        subs = load_weather_points(conn, codigos)
        print(
            f"Janela: {inicio} .. {fim} (inclusiva) | "
            f"subsistemas: {[s['codigo'] for s in subs]}"
        )
        for sub in subs:
            run(conn, sub, inicio, fim)
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    main()
