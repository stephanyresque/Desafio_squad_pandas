-- Migration 0004: carga média por subsistema (p/ normalizar sensibilidade em %/°C).
ALTER TABLE weather_sensitivity ADD COLUMN IF NOT EXISTS mean_load_mw numeric;