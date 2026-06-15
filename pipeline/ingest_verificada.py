"""Ingestão da carga verificada ONS (semi-horária) → load_actual horária no Supabase.

Wrapper fino sobre ingest.py com o tipo já fixado em "verificada". Toda a lógica
(fetch, agregação semi→horária, upsert idempotente, blocos mensais) vive em ingest.py.

Uso incremental (janela padrão hoje−10d..hoje):  python pipeline/ingest_verificada.py
Backfill:  python pipeline/ingest_verificada.py --inicio 2024-06-01 --fim 2026-06-15
"""

from __future__ import annotations

from ingest import cli

if __name__ == "__main__":
    cli(default_tipo="verificada")
