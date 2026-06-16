"use client";

import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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

const MODEL_COLOR = "#7c3aed"; // violeta — previsto (Ridge) e banda
const REAL_COLOR = "#2563eb"; // azul — real (verificada)

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

// Quantil empírico (interpolação linear) de um array já ORDENADO.
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

// Previsão ao vivo: chama o modelo Ridge servido para o subsistema selecionado e o dia
// ancorado (último dia completo de verificada), sobrepõe previsto × real e desenha a
// banda de incerteza de ~90% (quantis dos resíduos do Ridge por hora do dia).
export default function LiveForecast({
  subsystem,
  targetDate,
  realByTs,
  residualsByHour,
}: {
  subsystem: string;
  targetDate: string | null;
  realByTs: Record<string, number>;
  residualsByHour: number[][];
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  // Quantis q05/q95 dos resíduos do Ridge por hora do dia — recomputa só quando muda
  // o subsistema (novo residualsByHour). É a base da banda de ~90%.
  const bandByHour = useMemo(
    () =>
      residualsByHour.map((arr) => {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        return { q05: quantile(sorted, 0.05), q95: quantile(sorted, 0.95) };
      }),
    [residualsByHour],
  );

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

      {state.kind === "ok" && (
        <Result data={state.data} realByTs={realByTs} bandByHour={bandByHour} />
      )}
    </section>
  );
}

type Band = { q05: number; q95: number } | null;

type TipItem = { dataKey?: string | number; value?: number | string };

function ForecastTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TipItem[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const val = (k: string): number | null => {
    const it = payload.find((p) => p.dataKey === k);
    return it && it.value != null ? Number(it.value) : null;
  };
  const previsto = val("previsto");
  const real = val("real");
  const low = val("bandLow");
  const range = val("bandRange");

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">{label}</div>
      {previsto != null && (
        <div style={{ color: MODEL_COLOR }}>Previsto: {formatMw(previsto)} MWmed</div>
      )}
      {real != null && (
        <div style={{ color: REAL_COLOR }}>Real: {formatMw(real)} MWmed</div>
      )}
      {low != null && range != null && (
        <div className="text-zinc-500 dark:text-zinc-400">
          Faixa ~90%: {formatMw(low)}–{formatMw(low + range)} MWmed
        </div>
      )}
    </div>
  );
}

function Result({
  data,
  realByTs,
  bandByHour,
}: {
  data: ForecastResponse;
  realByTs: Record<string, number>;
  bandByHour: Band[];
}) {
  const chartData = data.predictions.map((p) => {
    const h = Number(p.target_ts.slice(11, 13));
    const band = bandByHour[h];
    return {
      hora: hourTick(p.target_ts),
      previsto: p.predicted_mw,
      real: realByTs[p.target_ts] ?? null,
      // banda absoluta = previsto + quantil; desenhada como base (transparente) + faixa.
      bandLow: band ? p.predicted_mw + band.q05 : null,
      bandRange: band ? band.q95 - band.q05 : null,
    };
  });

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
  const hasBand = chartData.some((d) => d.bandLow != null);

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
          <ComposedChart
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
              content={(props) => (
                <ForecastTooltip
                  active={props.active}
                  payload={props.payload as unknown as TipItem[] | undefined}
                  label={props.label as string | number | undefined}
                />
              )}
            />
            <Legend />
            {/* Banda primeiro (atrás): base transparente + faixa sombreada. */}
            {hasBand && (
              <Area
                dataKey="bandLow"
                stackId="band"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
                tooltipType="none"
                activeDot={false}
              />
            )}
            {hasBand && (
              <Area
                dataKey="bandRange"
                stackId="band"
                name="Faixa ~90%"
                stroke="none"
                fill={MODEL_COLOR}
                fillOpacity={0.18}
                isAnimationActive={false}
                activeDot={false}
              />
            )}
            {/* Linhas por cima da banda. */}
            <Line
              type="monotone"
              dataKey="previsto"
              name="Previsto (Ridge)"
              stroke={MODEL_COLOR}
              strokeWidth={2}
              dot={false}
            />
            {hasReal && (
              <Line
                type="monotone"
                dataKey="real"
                name="Real (verificada)"
                stroke={REAL_COLOR}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
        {hasBand && (
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            Faixa de confiança de ~90% (com base no histórico de erros por hora). Em ~90%
            dos dias, a carga real cai dentro desta faixa.
          </p>
        )}
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
