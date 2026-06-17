"""Ingestão da carga programada ONS (semi-horária) → load_official_forecast horária no Supabase.

Wrapper fino sobre ingest.py com o tipo já fixado em "programada". Toda a lógica
(fetch, agregação semi→horária, upsert idempotente, blocos mensais) vive em ingest.py.
"""

from __future__ import annotations

from src.ingest import cli

if __name__ == "__main__":
    cli(default_tipo="programada")
