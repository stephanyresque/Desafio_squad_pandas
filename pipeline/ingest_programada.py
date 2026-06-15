"""Ingestão da carga programada ONS (semi-horária) → load_official_forecast horária no Supabase.

Wrapper fino sobre ingest.py com o tipo já fixado em "programada". Toda a lógica
(fetch, agregação semi→horária, upsert idempotente, blocos mensais) vive em ingest.py.

Uso incremental (janela padrão hoje−10d..hoje):  python pipeline/ingest_programada.py
Backfill:  python pipeline/ingest_programada.py --inicio 2024-06-01 --fim 2026-06-15
"""

from __future__ import annotations

from ingest import cli

if __name__ == "__main__":
    cli(default_tipo="programada")
