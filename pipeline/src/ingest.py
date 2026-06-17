"""Ingestão de carga ONS (semi-horária) → tabela horária no Supabase.

Parametrizado por tipo: "verificada" → load_actual; "programada" →
load_official_forecast. Varre o intervalo em blocos mensais com upsert
idempotente. Regras de tratamento dos dados no README.

Uso: via os wrappers ingest_verificada.py / ingest_programada.py.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import date, timedelta, timezone
from typing import Iterator

import pandas as pd
import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values

BRASILIA = timezone(timedelta(hours=-3))
DEFAULT_LOOKBACK_DAYS = 10

load_dotenv()


@dataclass(frozen=True)
class TipoConfig:
    nome: str
    api_url: str
    val_field: str
    table: str
    has_atualizacao: bool


CONFIGS: dict[str, TipoConfig] = {
    "verificada": TipoConfig(
        nome="verificada",
        api_url="https://apicarga.ons.org.br/prd/cargaverificada",
        val_field="val_cargaglobal",
        table="load_actual",
        has_atualizacao=True,
    ),
    "programada": TipoConfig(
        nome="programada",
        api_url="https://apicarga.ons.org.br/prd/cargaprogramada",
        val_field="val_cargaglobalprogramada",
        table="load_official_forecast",
        has_atualizacao=False,
    ),
}


def default_date_window() -> tuple[date, date]:
    fim = date.today()
    inicio = fim - timedelta(days=DEFAULT_LOOKBACK_DAYS)
    return inicio, fim


def month_blocks(inicio: date, fim: date) -> Iterator[tuple[date, date]]:
    """Fatia [inicio, fim] (inclusive) em blocos mensais inclusivos."""
    atual = inicio
    while atual <= fim:
        if atual.month == 12:
            primeiro_proximo = date(atual.year + 1, 1, 1)
        else:
            primeiro_proximo = date(atual.year, atual.month + 1, 1)
        bloco_fim = min(fim, primeiro_proximo - timedelta(days=1))
        yield atual, bloco_fim
        atual = primeiro_proximo


def fetch(cfg: TipoConfig, cod_areacarga: str, inicio: date, fim: date) -> list[dict] | None:
    params = {
        "dat_inicio": inicio.isoformat(),
        "dat_fim": fim.isoformat(),
        "cod_areacarga": cod_areacarga,
    }
    try:
        response = requests.get(cfg.api_url, params=params, timeout=120)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"[{cfg.nome}/{cod_areacarga}] Erro HTTP: {exc}", file=sys.stderr)
        return None

    data = response.json()
    if not isinstance(data, list):
        print(
            f"[{cfg.nome}/{cod_areacarga}] Resposta inesperada (não é lista).",
            file=sys.stderr,
        )
        return None
    if not data:
        print(
            f"[{cfg.nome}/{cod_areacarga}] Resposta vazia para {inicio}..{fim}.",
            file=sys.stderr,
        )
        return None
    return data


def semi_hourly_to_hour_label(din_referenciautc: str) -> pd.Timestamp:
    fim_utc = pd.to_datetime(din_referenciautc, utc=True)
    fim_brasilia = fim_utc.tz_convert(BRASILIA)
    inicio = fim_brasilia - pd.Timedelta(minutes=30)
    return inicio.floor("h")


def aggregate_hourly(cfg: TipoConfig, records: list[dict]) -> pd.DataFrame:
    rows = []
    for record in records:
        row = {
            "hora_ts": semi_hourly_to_hour_label(record["din_referenciautc"]),
            "val": record[cfg.val_field],
        }
        if cfg.has_atualizacao:
            row["din_atualizacao"] = pd.to_datetime(record["din_atualizacao"], utc=True)
        rows.append(row)

    df = pd.DataFrame(rows)
    df = df[df["val"].notna() & (df["val"] != 0)]
    if df.empty:
        return df

    agg = {"load_mw": ("val", "mean")}
    if cfg.has_atualizacao:
        agg["din_atualizacao"] = ("din_atualizacao", "max")

    hourly = (
        df.groupby("hora_ts", as_index=False)
        .agg(**agg)
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


def upsert(cfg: TipoConfig, conn, subsystem_id: int, hourly: pd.DataFrame) -> int:
    if hourly.empty:
        return 0

    if cfg.has_atualizacao:
        rows = [
            (
                subsystem_id,
                row.hora_ts.to_pydatetime(),
                float(row.load_mw),
                row.din_atualizacao.to_pydatetime(),
            )
            for row in hourly.itertuples(index=False)
        ]
        sql = f"""
            INSERT INTO {cfg.table} (subsystem_id, ts, load_mw, din_atualizacao)
            VALUES %s
            ON CONFLICT (subsystem_id, ts) DO UPDATE SET
                load_mw = EXCLUDED.load_mw,
                din_atualizacao = EXCLUDED.din_atualizacao
            RETURNING 1
        """
    else:
        rows = [
            (
                subsystem_id,
                row.hora_ts.to_pydatetime(),
                float(row.load_mw),
            )
            for row in hourly.itertuples(index=False)
        ]
        sql = f"""
            INSERT INTO {cfg.table} (subsystem_id, ts, load_mw)
            VALUES %s
            ON CONFLICT (subsystem_id, ts) DO UPDATE SET
                load_mw = EXCLUDED.load_mw
            RETURNING 1
        """

    with conn.cursor() as cur:
        result = execute_values(cur, sql, rows, fetch=True)
        return len(result)


def run(
    cfg: TipoConfig,
    conn,
    subsystem_id: int,
    codigo: str,
    inicio: date,
    fim: date,
) -> None:
    """Varre [inicio, fim] em blocos mensais, com upsert (e commit) por bloco."""
    print(f"[{cfg.nome}/{codigo}] janela total: {inicio} .. {fim} (inclusiva)")

    total_horas = 0
    total_upsert = 0
    blocos_com_dado = 0
    blocos_vazios = 0

    for bloco_inicio, bloco_fim in month_blocks(inicio, fim):
        records = fetch(cfg, codigo, bloco_inicio, bloco_fim)
        if records is None:
            blocos_vazios += 1
            print(f"  {bloco_inicio}..{bloco_fim}: sem dado, segue")
            continue

        hourly = aggregate_hourly(cfg, records)
        upserted = upsert(cfg, conn, subsystem_id, hourly)
        conn.commit()  # checkpoint por bloco — backfill retomável

        total_horas += len(hourly)
        total_upsert += upserted
        blocos_com_dado += 1
        print(
            f"  {bloco_inicio}..{bloco_fim}: "
            f"semi-horários={len(records)} | horas={len(hourly)} | upsert={upserted}"
        )

    print(
        f"[{cfg.nome}/{codigo}] FIM: horas={total_horas} | upsert={total_upsert} | "
        f"blocos com dado={blocos_com_dado} | blocos vazios={blocos_vazios}"
    )


def parse_args(default_tipo: str | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingestão de carga ONS (verificada/programada) com blocos mensais."
    )
    parser.add_argument(
        "--tipo",
        choices=sorted(CONFIGS),
        default=default_tipo,
        required=default_tipo is None,
        help="Tipo de carga a ingerir.",
    )
    parser.add_argument(
        "--codigo",
        default="SECO",
        help="cod_areacarga do subsistema (padrão: SECO).",
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


def cli(default_tipo: str | None = None) -> None:
    args = parse_args(default_tipo)
    cfg = CONFIGS[args.tipo]

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
        subsystem_ids = load_subsystem_ids(conn, [args.codigo])
        run(cfg, conn, subsystem_ids[args.codigo], args.codigo, inicio, fim)
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    cli()
