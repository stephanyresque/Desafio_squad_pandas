"use client";

import { useState } from "react";
import {
  CartesianGrid,
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

function hourLabel(targetTs: string): string {
  return targetTs.slice(11, 16); // "HH:MM" da hora-rótulo em Brasília
}

function formatMw(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

// Previsão ao vivo: chama GET /api/forecast (o modelo Ridge servido) para o subsistema
// selecionado e a data D+1 sugerida, e mostra as 24 horas. Trata loading/erro/sucesso.
export default function LiveForecast({
  subsystem,
  targetDate,
}: {
  subsystem: string;
  targetDate: string | null;
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
          message: json?.error ?? `Erro ${res.status} ao prever.`,
        });
        return;
      }
      setState({ kind: "ok", data: json as ForecastResponse });
    } catch (e) {
      setState({ kind: "error", message: `Falha de rede: ${String(e)}` });
    }
  }

  const chartData =
    state.kind === "ok"
      ? state.data.predictions.map((p) => ({
          hora: hourLabel(p.target_ts),
          mw: p.predicted_mw,
        }))
      : [];

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
            ? "Prevendo…"
            : `Prever D+1${targetDate ? ` (${targetDate})` : ""}`}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Ridge servido via /api/forecast — 24h day-ahead, computado ao vivo em TS.
      </p>

      {state.kind === "error" && (
        <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {state.message}
        </p>
      )}

      {state.kind === "ok" && (
        <div className="mt-4">
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            {state.data.subsystem} · {state.data.target_date} ·{" "}
            {state.data.predictions.length} horas
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis
                dataKey="hora"
                tick={{ fontSize: 11, fill: "#71717a" }}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(v: number) => v.toLocaleString("pt-BR")}
                tick={{ fontSize: 11, fill: "#71717a" }}
                width={64}
              />
              <Tooltip
                formatter={(v) => [`${formatMw(Number(v))} MWmed`, "Previsto"]}
              />
              <Line
                type="monotone"
                dataKey="mw"
                name="Previsto"
                stroke="#16a34a"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-1 pr-4 font-medium">Hora</th>
                  <th className="py-1 font-medium">Previsto (MWmed)</th>
                </tr>
              </thead>
              <tbody>
                {state.data.predictions.map((p) => (
                  <tr
                    key={p.target_ts}
                    className="border-b border-zinc-100 dark:border-zinc-900"
                  >
                    <td className="py-1 pr-4 tabular-nums">{hourLabel(p.target_ts)}</td>
                    <td className="py-1 tabular-nums">{formatMw(p.predicted_mw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
