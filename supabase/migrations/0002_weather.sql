-- Migration 0002: dado climático (Open-Meteo) — tabela weather_actual + ponto
-- representativo por subsistema. Idempotente — seguro reexecutar no SQL Editor.

-- 1) Ponto representativo por subsistema (cidade-âncora p/ temperatura)
ALTER TABLE subsystems ADD COLUMN IF NOT EXISTS weather_city text;
ALTER TABLE subsystems ADD COLUMN IF NOT EXISTS weather_lat  numeric;
ALTER TABLE subsystems ADD COLUMN IF NOT EXISTS weather_lon  numeric;

UPDATE subsystems SET weather_city = 'São Paulo',    weather_lat = -23.5558, weather_lon = -46.6396 WHERE codigo = 'SECO';
UPDATE subsystems SET weather_city = 'Porto Alegre', weather_lat = -30.0368, weather_lon = -51.2090 WHERE codigo = 'S';
UPDATE subsystems SET weather_city = 'Recife',       weather_lat = -8.0578,  weather_lon = -34.8829 WHERE codigo = 'NE';
UPDATE subsystems SET weather_city = 'Belém',        weather_lat = -1.4563,  weather_lon = -48.5013 WHERE codigo = 'N';

-- 2) Tabela de temperatura horária (espelha o padrão de load_actual)
CREATE TABLE IF NOT EXISTS weather_actual (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subsystem_id int         NOT NULL REFERENCES subsystems (id),
    ts           timestamptz NOT NULL,
    temp_c       numeric     NOT NULL,
    source       text        NOT NULL,
    extracted_at timestamptz NOT NULL,
    UNIQUE (subsystem_id, ts)
);

CREATE INDEX IF NOT EXISTS weather_actual_ts_brin
    ON weather_actual USING brin (ts);

-- 3) RLS + leitura pública via anon (escrita só service_role)
ALTER TABLE weather_actual ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON weather_actual TO anon;

DROP POLICY IF EXISTS weather_actual_anon_select ON weather_actual;
CREATE POLICY weather_actual_anon_select
    ON weather_actual FOR SELECT TO anon USING (true);