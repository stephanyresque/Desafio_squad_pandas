"""Exploração READ-ONLY da API Open-Meteo (ERA5) — confirma contrato e fuso."""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta, timezone

import pandas as pd
import psycopg2
import requests
from dotenv import load_dotenv

BRASILIA = timezone(timedelta(hours=-3)) 
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
CODIGO = "SECO"

load_dotenv()


def utc_to_brasilia_hour(time_utc: str) -> pd.Timestamp:
    """Hora UTC do Open-Meteo → hora-rótulo de Brasília (converte ao fuso e floor)."""
    return pd.to_datetime(time_utc, utc=True).tz_convert(BRASILIA).floor("h")


def fetch_weather_point(conn) -> tuple[float, float]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT weather_lat, weather_lon FROM subsystems WHERE codigo = %s",
            (CODIGO,),
        )
        row = cur.fetchone()
    if row is None:
        raise RuntimeError(f"Subsistema {CODIGO} não encontrado em subsystems.")
    if row[0] is None or row[1] is None:
        raise RuntimeError(
            f"weather_lat/weather_lon nulos para {CODIGO} "
            "(rode a migration 0002_weather.sql)."
        )
    return float(row[0]), float(row[1])


def fetch_load_actual_hours(conn, lo, hi) -> set:
    """Horas de load_actual (SECO) no intervalo [lo, hi], normalizadas para UTC."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT la.ts
            FROM load_actual la
            JOIN subsystems s ON s.id = la.subsystem_id
            WHERE s.codigo = %s AND la.ts BETWEEN %s AND %s
            """,
            (CODIGO, lo, hi),
        )
        return {row[0].astimezone(timezone.utc) for row in cur.fetchall()}


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL não definida (.env na raiz).", file=sys.stderr)
        sys.exit(1)

    # Janela recente porém dentro do alcance do ERA5 (alguns dias de atraso).
    fim = date.today() - timedelta(days=10)
    inicio = date.today() - timedelta(days=20)

    conn = psycopg2.connect(database_url)
    try:
        lat, lon = fetch_weather_point(conn)

        print(f"=== Open-Meteo — exploração READ-ONLY ({CODIGO}) ===")
        print(f"Ponto: lat={lat}, lon={lon} (subsystems.weather_lat/lon)")
        print(f"Janela ERA5: {inicio.isoformat()} .. {fim.isoformat()} (hoje−20 .. hoje−10)")
        print()

        params = {
            "latitude": lat,
            "longitude": lon,
            "start_date": inicio.isoformat(),
            "end_date": fim.isoformat(),
            "hourly": "temperature_2m",
            "timezone": "UTC",
        }
        resp = requests.get(ARCHIVE_URL, params=params, timeout=60)
        resp.raise_for_status()
        data = resp.json()

        print(f"HTTP: {resp.status_code}")
        print(f"hourly_units: {data.get('hourly_units')}")
        print(f"utc_offset_seconds: {data.get('utc_offset_seconds')}")

        times = data["hourly"]["time"]
        temps = data["hourly"]["temperature_2m"]
        print("Primeiras 5 (time UTC, temperature_2m):")
        for t, v in list(zip(times, temps))[:5]:
            print(f"  {t}  {v}")
        print()

        # Conversão UTC → hora-rótulo de Brasília (floor para a hora).
        labels = [utc_to_brasilia_hour(t) for t in times]
        if labels:
            print("Conversão UTC → hora-rótulo Brasília (exemplo):")
            print(f"  {times[0]} UTC  →  {labels[0].isoformat()}")
            print()

        labels_utc = {lbl.tz_convert("UTC").to_pydatetime() for lbl in labels}

        # Alinhamento com load_actual no mesmo intervalo (em instantes UTC).
        lo = min(labels_utc)
        hi = max(labels_utc)
        load_hours = fetch_load_actual_hours(conn, lo, hi)

        matched = sorted(lbl for lbl in labels_utc if lbl in load_hours)
        unmatched = sorted(lbl for lbl in labels_utc if lbl not in load_hours)
        total = len(labels_utc)

        print("Alinhamento temperatura × load_actual (SECO):")
        print(f"  horas de load_actual no intervalo: {len(load_hours)}")
        print(f"  casaram: {len(matched)}/{total} horas")
        print(f"  não casaram: {len(unmatched)}")
        if unmatched:
            exemplos = [
                ts.astimezone(BRASILIA).isoformat() for ts in unmatched[:5]
            ]
            print(f"  exemplos sem par (hora-rótulo Brasília): {exemplos}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
