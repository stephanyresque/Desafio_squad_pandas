"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { type LoadChartPoint } from "./load-chart";

const MODEL_COLOR = "#7c3aed"; // violeta — barras (resíduos do modelo)
const ZERO_COLOR = "#52525b"; // zinc — linha do zero
const MEAN_COLOR = "#e11d48"; // rose — linha da média (viés)

const BINS = 41; // ímpar → uma faixa centrada no zero

function fmtMw(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

type Stats = {
  bins: { x: number; count: number }[];
  mean: number;
  std: number;
  pctWithin1Std: number;
  n: number;
};

// Resíduo = real − previsto (MWmed, COM SINAL). Positivo = modelo subestimou.
// Só horas com as duas pontas (verificada e modelo).
function compute(data: LoadChartPoint[]): Stats | null {
  const residuals: number[] = [];
  for (const p of data) {
    if (p.verificada != null && p.modelo != null) {
      residuals.push(p.verificada - p.modelo);
    }
  }
  const n = residuals.length;
  if (n === 0) return null;

  const mean = residuals.reduce((s, r) => s + r, 0) / n;
  const variance =
    n > 1
      ? residuals.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (n - 1)
      : 0;
  const std = Math.sqrt(variance);

  let within = 0;
  for (const r of residuals) {
    if (Math.abs(r - mean) <= std) within += 1;
  }
  const pctWithin1Std = (within / n) * 100;

  // Faixas simétricas em torno do zero (largura uniforme), para o zero ficar centrado.
  let absMax = 0;
  for (const r of residuals) absMax = Math.max(absMax, Math.abs(r));
  if (absMax === 0) absMax = 1;
  const width = (2 * absMax) / BINS;

  const counts = new Array(BINS).fill(0);
  for (const r of residuals) {
    let idx = Math.floor((r + absMax) / width);
    if (idx < 0) idx = 0;
    if (idx >= BINS) idx = BINS - 1;
    counts[idx] += 1;
  }
  const bins = counts.map((count, i) => ({
    x: -absMax + (i + 0.5) * width,
    count,
  }));

  return { bins, mean, std, pctWithin1Std, n };
}

export default function ResidualsHistogram({ data }: { data: LoadChartPoint[] }) {
  const stats = useMemo(() => compute(data), [data]);

  if (!stats) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Distribuição dos erros
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sem resíduos do modelo para este subsistema.
        </p>
      </section>
    );
  }

  const { bins, mean, std, pctWithin1Std, n } = stats;
  const absMax = Math.abs(bins[0].x) + (bins[1].x - bins[0].x) / 2;

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Distribuição dos erros
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Resíduos do modelo (LightGBM) ao longo do backtest: resíduo = real − previsto, em
        MWmed e com sinal (positivo = o modelo subestimou; negativo = superestimou).
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Erros concentrados em torno de zero e simétricos indicam um modelo sem viés
        sistemático — ele não tende a errar sempre para o mesmo lado.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Média dos resíduos" value={`${fmtMw(mean)} MWmed`} hint="ideal ≈ 0 (viés)" />
        <Stat label="Desvio-padrão" value={`${fmtMw(std)} MWmed`} hint="dispersão do erro" />
        <Stat
          label="Dentro de ±1 desvio"
          value={`${pctWithin1Std.toLocaleString("pt-BR", {
            maximumFractionDigits: 0,
          })}%`}
          hint={`${n.toLocaleString("pt-BR")} horas`}
        />
      </div>

      <div className="mt-4">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={bins} margin={{ top: 16, right: 16, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={[-absMax, absMax]}
              tickFormatter={fmtMw}
              tick={{ fontSize: 11, fill: "#71717a" }}
              label={{
                value: "Resíduo (MWmed)",
                position: "insideBottom",
                offset: -4,
                fill: "#71717a",
                fontSize: 12,
              }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#71717a" }}
              width={48}
              label={{
                value: "horas",
                angle: -90,
                position: "insideLeft",
                fill: "#71717a",
                fontSize: 12,
              }}
            />
            <Tooltip
              formatter={(v) => [`${fmtMw(Number(v))} horas`, "Frequência"]}
              labelFormatter={(label) => `Resíduo ≈ ${fmtMw(Number(label))} MWmed`}
            />
            <Bar dataKey="count" fill={MODEL_COLOR} isAnimationActive={false} />
            <ReferenceLine
              x={0}
              stroke={ZERO_COLOR}
              strokeWidth={2}
              label={{ value: "0", position: "top", fill: ZERO_COLOR, fontSize: 11 }}
            />
            <ReferenceLine
              x={mean}
              stroke={MEAN_COLOR}
              strokeWidth={2}
              strokeDasharray="5 3"
              label={{
                value: `média ${fmtMw(mean)}`,
                position: "top",
                fill: MEAN_COLOR,
                fontSize: 11,
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
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
      <p className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}
