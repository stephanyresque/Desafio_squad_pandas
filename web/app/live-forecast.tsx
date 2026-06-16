"use client";

import { useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type ForecastPoint = { target_ts: string; predicted_mw: number };
type ForecastResponse = {
  subsystem: string;
  target_date: string;
  model_name: string;
  predictions: ForecastPoint[];
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; data: ForecastResponse };

function hourTick(targetTs: string): string {
  return `${targetTs.slice(11, 13)}h`; // "00h".."23h" da hora-rótulo em Brasília
}

function formatMw(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

function formatDateBr(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

// Previsão ao vivo: chama o modelo Ridge servido para o subsistema selecionado e o dia
// ancorado (último dia completo de verificada), e sobrepõe previsto × real.
export default function LiveForecast({
  subsystem,
  targetDate,
  realByTs,
}: {
  subsystem: string;
  targetDate: string | null;
  realByTs: Record<string, number>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    try {
      const params = new URLSearchParams({ subsystem });
      if (targetDate) params.set("date", targetDate);
      const res = await fetch(`/api/forecast?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        setState({
          kind: "error",
          message: json?.error ?? `Erro ${res.status} ao gerar a previsão.`,
        });
        return;
      }
      setState({ kind: "ok", data: json as ForecastResponse });
    } catch (e) {
      setState({ kind: "error", message: `Falha de rede: ${String(e)}` });
    }
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Previsão ao vivo (modelo servido)
        </h2>
        <button
          type="button"
          onClick={run}
          disabled={state.kind === "loading"}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {state.kind === "loading"
            ? "Gerando…"
            : "Gerar previsão do dia seguinte"}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Dia seguinte ao último dado disponível do ONS; calculado ao vivo pelo modelo
        Ridge.
      </p>

      {state.kind === "loading" && (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          Calculando as 24 horas…
        </p>
      )}

      {state.kind === "error" && (
        <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {state.message}
        </p>
      )}

      {state.kind === "ok" && <Result data={state.data} realByTs={realByTs} />}
    </section>
  );
}

function Result({
  data,
  realByTs,
}: {
  data: ForecastResponse;
  realByTs: Record<string, number>;
}) {
  const chartData = data.predictions.map((p) => ({
    hora: hourTick(p.target_ts),
    previsto: p.predicted_mw,
    real: realByTs[p.target_ts] ?? null,
  }));

  // Manchetes do dia previsto.
  let peak = -Infinity;
  let peakHora = "";
  let sum = 0;
  for (const row of chartData) {
    sum += row.previsto;
    if (row.previsto > peak) {
      peak = row.previsto;
      peakHora = row.hora;
    }
  }
  const mean = chartData.length ? sum / chartData.length : 0;

  // MAPE do dia: só nas horas com previsto E real. Sem par → oculta o erro.
  let pairs = 0;
  let sumAbsPct = 0;
  for (const row of chartData) {
    if (row.real != null && row.real !== 0) {
      pairs += 1;
      sumAbsPct += Math.abs(row.previsto - row.real) / row.real;
    }
  }
  const hasReal = pairs > 0;
  const mape = hasReal ? (sumAbsPct / pairs) * 100 : null;

  return (
    <div className="mt-4">
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
        Previsão ao vivo — {formatDateBr(data.target_date)}
      </h3>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Pico previsto"
          value={`${formatMw(peak)} MWmed`}
          hint={`às ${peakHora}`}
        />
        <Stat label="Média prevista" value={`${formatMw(mean)} MWmed`} hint="no dia" />
        <Stat
          label="Erro do dia (MAPE)"
          value={
            mape != null
              ? `${mape.toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}%`
              : "—"
          }
          hint={
            mape != null
              ? `previsto × real · ${pairs}h`
              : "verificada indisponível para este dia"
          }
        />
      </div>

      <div className="mt-4">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart
            data={chartData}
            margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis
              dataKey="hora"
              tick={{ fontSize: 11, fill: "#71717a" }}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={(v: number) => v.toLocaleString("pt-BR")}
              tick={{ fontSize: 11, fill: "#71717a" }}
              width={64}
              label={{
                value: "MWmed",
                angle: -90,
                position: "insideLeft",
                fill: "#71717a",
                fontSize: 12,
              }}
            />
            <Tooltip
              formatter={(v, name) => [
                v == null ? "—" : `${formatMw(Number(v))} MWmed`,
                String(name),
              ]}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="previsto"
              name="Previsto (Ridge)"
              stroke="#7c3aed"
              strokeWidth={2}
              dot={false}
            />
            {hasReal && (
              <Line
                type="monotone"
                dataKey="real"
                name="Real (verificada)"
                stroke="#2563eb"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}
