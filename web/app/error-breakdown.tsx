"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { brFields } from "@/lib/forecast/features";
import { type LoadChartPoint } from "./load-chart";

const MODEL_COLOR = "#AC4DFF"; // roxo — modelo (LightGBM)
const ONS_COLOR = "#FF6A00"; // laranja — programada ONS

// Feriados (horário de Brasília). Array de 'YYYY-MM-DD' fácil de editar.
// Feriado tem prioridade sobre fim de semana / dia útil.
const FERIADOS: string[] = [
  // --- Fixos nacionais (por ano coberto) ---
  "2024-01-01", "2024-04-21", "2024-05-01", "2024-09-07", "2024-10-12",
  "2024-11-02", "2024-11-15", "2024-11-20", "2024-12-25",
  "2025-01-01", "2025-04-21", "2025-05-01", "2025-09-07", "2025-10-12",
  "2025-11-02", "2025-11-15", "2025-11-20", "2025-12-25",
  "2026-01-01", "2026-04-21", "2026-05-01", "2026-09-07", "2026-10-12",
  "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25",
  // --- Móveis / dias atípicos de carga ---
  "2024-02-13", "2025-03-04", "2026-02-17", // Carnaval (terça)
  "2024-03-29", "2025-04-18", "2026-04-03", // Sexta-feira Santa
  "2024-05-30", "2025-06-19", "2026-06-04", // Corpus Christi
];
const FERIADOS_SET = new Set(FERIADOS);

const DAY_TYPES = ["Dia útil", "Fim de semana", "Feriado"] as const;
type DayType = (typeof DAY_TYPES)[number];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pct(value: number): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

type HourRow = { hora: number; modelo: number | null; ons: number | null };
type TypeRow = { name: DayType; modelo: number | null; ons: number | null; dias: number };

type Acc = { sum: number; n: number };
const newAcc = (): Acc => ({ sum: 0, n: 0 });
const mape = (a: Acc): number | null => (a.n > 0 ? (a.sum / a.n) * 100 : null);

// Resíduos hora a hora: |real − previsto| / real, só onde há as duas pontas.
// Agrupa por hora-do-dia e por tipo de dia, em horário de Brasília.
function compute(data: LoadChartPoint[]): { byHour: HourRow[]; byType: TypeRow[] } {
  const hourModel = Array.from({ length: 24 }, newAcc);
  const hourOns = Array.from({ length: 24 }, newAcc);
  const typeModel: Record<DayType, Acc> = {
    "Dia útil": newAcc(),
    "Fim de semana": newAcc(),
    Feriado: newAcc(),
  };
  const typeOns: Record<DayType, Acc> = {
    "Dia útil": newAcc(),
    "Fim de semana": newAcc(),
    Feriado: newAcc(),
  };
  const typeDays: Record<DayType, Set<string>> = {
    "Dia útil": new Set(),
    "Fim de semana": new Set(),
    Feriado: new Set(),
  };

  for (const p of data) {
    const f = brFields(Date.parse(p.ts));
    const dateKey = `${f.year}-${pad2(f.month)}-${pad2(f.day)}`;

    const cat: DayType = FERIADOS_SET.has(dateKey)
      ? "Feriado"
      : f.dow >= 5
        ? "Fim de semana"
        : "Dia útil";
    typeDays[cat].add(dateKey);

    const real = p.verificada;
    if (real == null || real === 0) continue;

    if (p.modelo != null) {
      const e = Math.abs(real - p.modelo) / real;
      hourModel[f.hour].sum += e;
      hourModel[f.hour].n += 1;
      typeModel[cat].sum += e;
      typeModel[cat].n += 1;
    }
    if (p.programada != null) {
      const e = Math.abs(real - p.programada) / real;
      hourOns[f.hour].sum += e;
      hourOns[f.hour].n += 1;
      typeOns[cat].sum += e;
      typeOns[cat].n += 1;
    }
  }

  const byHour: HourRow[] = Array.from({ length: 24 }, (_, h) => ({
    hora: h,
    modelo: mape(hourModel[h]),
    ons: mape(hourOns[h]),
  }));
  const byType: TypeRow[] = DAY_TYPES.map((t) => ({
    name: t,
    modelo: mape(typeModel[t]),
    ons: mape(typeOns[t]),
    dias: typeDays[t].size,
  }));

  return { byHour, byType };
}

export default function ErrorBreakdown({ data }: { data: LoadChartPoint[] }) {
  const { byHour, byType } = useMemo(() => compute(data), [data]);

  const tooltip = (
    <Tooltip
      formatter={(v, name) => [v == null ? "—" : pct(Number(v)), String(name)]}
    />
  );

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Onde mora o erro
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Erro do modelo (LightGBM) × programada ONS, recortado por hora do dia e por tipo
        de dia (teste retroativo, horário de Brasília). Em geral o erro cresce nas horas de rampa
        (manhã e início da noite) e em dias atípicos.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recorte 1 — por hora do dia */}
        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            MAPE por hora do dia
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={byHour} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis
                dataKey="hora"
                interval={2}
                tickFormatter={(h: number) => `${h}h`}
                tick={{ fontSize: 11, fill: "#71717a" }}
              />
              <YAxis
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11, fill: "#71717a" }}
                width={44}
              />
              {tooltip}
              <Legend />
              <Line
                type="monotone"
                dataKey="modelo"
                name="Modelo (LightGBM)"
                stroke={MODEL_COLOR}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="ons"
                name="ONS"
                stroke={ONS_COLOR}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Recorte 2 — por tipo de dia */}
        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            MAPE por tipo de dia
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={byType} margin={{ top: 8, right: 16, left: 8, bottom: 8 }} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
              <XAxis
                dataKey="name"
                interval={0}
                tick={{ fontSize: 12, fill: "#71717a" }}
              />
              <YAxis
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11, fill: "#71717a" }}
                width={44}
              />
              {tooltip}
              <Legend />
              <Bar dataKey="modelo" name="Modelo (LightGBM)" fill={MODEL_COLOR} radius={[2, 2, 0, 0]} />
              <Bar dataKey="ons" name="ONS" fill={ONS_COLOR} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            Amostra (dias no período):{" "}
            {byType.map((t, i) => (
              <span key={t.name}>
                {i > 0 && " · "}
                {t.name} {t.dias}
              </span>
            ))}
            . Feriado tem poucos dias, leia com cautela.
          </p>
        </div>
      </div>
    </section>
  );
}
