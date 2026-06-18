-- Migration 0003: sensibilidade da carga à temperatura (resultado da análise,
-- 1 linha por subsistema). Idempotente — seguro reexecutar no SQL Editor.

CREATE TABLE IF NOT EXISTS weather_sensitivity (
    subsystem_id        int PRIMARY KEY REFERENCES subsystems (id),
    balance_c           numeric     NOT NULL,   -- T_eq (ponto de equilíbrio, °C)
    slope_cool_mw_per_c numeric     NOT NULL,   -- MWmed por °C ACIMA de T_eq
    slope_heat_mw_per_c numeric     NOT NULL,   -- MWmed por °C ABAIXO de T_eq
    intercept_mw        numeric     NOT NULL,   -- carga no T_eq (dia útil)
    r2                  numeric,
    n_days              int         NOT NULL,
    curve               jsonb       NOT NULL,   -- [{temp, observed, fitted, n}, ...]
    computed_at         timestamptz NOT NULL,
    source              text        NOT NULL
);

ALTER TABLE weather_sensitivity ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON weather_sensitivity TO anon;

DROP POLICY IF EXISTS weather_sensitivity_anon_select ON weather_sensitivity;
CREATE POLICY weather_sensitivity_anon_select
    ON weather_sensitivity FOR SELECT TO anon USING (true);