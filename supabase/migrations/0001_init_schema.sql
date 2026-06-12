-- Migration inicial: schema de previsão de carga elétrica (6 tabelas ONS + RLS leitura pública).
-- Idempotente — seguro para reexecução no SQL Editor do Supabase.

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subsystems (
    id     int  PRIMARY KEY,
    codigo text NOT NULL,
    nome   text NOT NULL
);

CREATE TABLE IF NOT EXISTS load_actual (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subsystem_id    int          NOT NULL REFERENCES subsystems (id),
    ts              timestamptz  NOT NULL,
    load_mw         numeric      NOT NULL,
    din_atualizacao timestamptz  NOT NULL,
    UNIQUE (subsystem_id, ts)
);

CREATE TABLE IF NOT EXISTS load_official_forecast (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subsystem_id int         NOT NULL REFERENCES subsystems (id),
    ts           timestamptz NOT NULL,
    load_mw      numeric     NOT NULL,
    UNIQUE (subsystem_id, ts)
);

CREATE TABLE IF NOT EXISTS model_runs (
    id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_name  text        NOT NULL,
    trained_at  timestamptz NOT NULL,
    hyperparams jsonb,
    artifact    jsonb,
    git_commit  text,
    train_start date,
    train_end   date
);

CREATE TABLE IF NOT EXISTS predictions (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_run_id  int         NOT NULL REFERENCES model_runs (id),
    subsystem_id  int         NOT NULL REFERENCES subsystems (id),
    target_ts     timestamptz NOT NULL,
    predicted_mw  numeric     NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_run_id int     NOT NULL REFERENCES model_runs (id),
    subsystem_id int     NOT NULL REFERENCES subsystems (id),
    predictor    text    NOT NULL,
    metric       text    NOT NULL,
    value        numeric NOT NULL,
    horizon_h    int     NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2) Índices (UNIQUE já declarado nas tabelas acima)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS load_actual_ts_brin
    ON load_actual USING brin (ts);

CREATE INDEX IF NOT EXISTS load_official_forecast_ts_brin
    ON load_official_forecast USING brin (ts);

CREATE INDEX IF NOT EXISTS predictions_model_run_id_idx
    ON predictions (model_run_id);

CREATE INDEX IF NOT EXISTS evaluations_model_run_id_idx
    ON evaluations (model_run_id);

-- ---------------------------------------------------------------------------
-- 3) Seed — dimensão subsystems (ids explícitos 1..4)
-- ---------------------------------------------------------------------------

INSERT INTO subsystems (id, codigo, nome) VALUES
    (1, 'SECO', 'SE/CO'),
    (2, 'S',    'S'),
    (3, 'NE',   'NE'),
    (4, 'N',    'N')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) Segurança — RLS + leitura pública via anon (escritas só service_role)
-- ---------------------------------------------------------------------------

ALTER TABLE subsystems              ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_actual             ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_official_forecast  ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_runs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations             ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO anon;

GRANT SELECT ON subsystems             TO anon;
GRANT SELECT ON load_actual            TO anon;
GRANT SELECT ON load_official_forecast TO anon;
GRANT SELECT ON model_runs             TO anon;
GRANT SELECT ON predictions            TO anon;
GRANT SELECT ON evaluations            TO anon;

DROP POLICY IF EXISTS subsystems_anon_select             ON subsystems;
DROP POLICY IF EXISTS load_actual_anon_select            ON load_actual;
DROP POLICY IF EXISTS load_official_forecast_anon_select ON load_official_forecast;
DROP POLICY IF EXISTS model_runs_anon_select             ON model_runs;
DROP POLICY IF EXISTS predictions_anon_select            ON predictions;
DROP POLICY IF EXISTS evaluations_anon_select            ON evaluations;

CREATE POLICY subsystems_anon_select
    ON subsystems FOR SELECT TO anon USING (true);

CREATE POLICY load_actual_anon_select
    ON load_actual FOR SELECT TO anon USING (true);

CREATE POLICY load_official_forecast_anon_select
    ON load_official_forecast FOR SELECT TO anon USING (true);

CREATE POLICY model_runs_anon_select
    ON model_runs FOR SELECT TO anon USING (true);

CREATE POLICY predictions_anon_select
    ON predictions FOR SELECT TO anon USING (true);

CREATE POLICY evaluations_anon_select
    ON evaluations FOR SELECT TO anon USING (true);
