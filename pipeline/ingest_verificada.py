"""Ingestão da carga verificada ONS (semi-horária) → load_actual horária no Supabase.

Wrapper fino sobre ingest.py com o tipo já fixado em "verificada". Toda a lógica
(fetch, agregação semi→horária, upsert idempotente, blocos mensais) vive em ingest.py.
"""

from __future__ import annotations

from src.ingest import cli

if __name__ == "__main__":
    cli(default_tipo="verificada")
