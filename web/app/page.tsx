import { createClient } from "@/lib/supabase";

import LoadChart, { type LoadChartPoint } from "./load-chart";

export const dynamic = "force-dynamic";

function combineSeries(
  actualRows: { ts: string; load_mw: number | string }[],
  forecastRows: { ts: string; load_mw: number | string }[],
): LoadChartPoint[] {
  const byTs = new Map<string, LoadChartPoint>();

  for (const row of actualRows) {
    byTs.set(row.ts, {
      ts: row.ts,
      verificada: Number(row.load_mw),
      programada: null,
    });
  }

  for (const row of forecastRows) {
    const existing = byTs.get(row.ts);
    if (existing) {
      existing.programada = Number(row.load_mw);
    } else {
      byTs.set(row.ts, {
        ts: row.ts,
        verificada: null,
        programada: Number(row.load_mw),
      });
    }
  }

  return Array.from(byTs.values()).sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );
}

type OnsKpis = {
  n: number;
  mape: number;
  mae: number;
  rmse: number;
};

// Erro da programada (previsão ONS) contra a verificada (real), só nas horas
// comparáveis: ambas não-nulas. Programada = previsão; verificada = real.
function computeOnsKpis(data: LoadChartPoint[]): OnsKpis | null {
  let n = 0;
  let sumAbsPct = 0;
  let sumAbs = 0;
  let sumSq = 0;

  for (const point of data) {
    if (point.verificada == null || point.programada == null) {
      continue;
    }
    if (point.verificada === 0) {
      continue; // evita divisão por zero no MAPE (a ingestão já descarta zeros)
    }
    const erro = point.programada - point.verificada;
    n += 1;
    sumAbsPct += Math.abs(erro) / point.verificada;
    sumAbs += Math.abs(erro);
    sumSq += erro * erro;
  }

  if (n === 0) {
    return null;
  }

  return {
    n,
    mape: (sumAbsPct / n) * 100,
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
  };
}

export default async function Home() {
  const supabase = createClient();

  const [actualResult, forecastResult] = await Promise.all([
    supabase
      .from("load_actual")
      .select("ts, load_mw, subsystems!inner(codigo)")
      .eq("subsystems.codigo", "SECO")
      .order("ts", { ascending: true }),
    supabase
      .from("load_official_forecast")
      .select("ts, load_mw, subsystems!inner(codigo)")
      .eq("subsystems.codigo", "SECO")
      .order("ts", { ascending: true }),
  ]);

  const error = actualResult.error ?? forecastResult.error;
  if (error) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
        <p className="text-red-600">Erro ao carregar dados: {error.message}</p>
      </main>
    );
  }

  const chartData = combineSeries(
    actualResult.data ?? [],
    forecastResult.data ?? [],
  );

  const kpis = computeOnsKpis(chartData);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
      {kpis && (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            label="MAPE do ONS"
            value={`${kpis.mape.toLocaleString("pt-BR", {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })}%`}
            n={kpis.n}
          />
          <KpiCard
            label="MAE"
            value={`${Math.round(kpis.mae).toLocaleString("pt-BR")} MWmed`}
            n={kpis.n}
          />
          <KpiCard
            label="RMSE"
            value={`${Math.round(kpis.rmse).toLocaleString("pt-BR")} MWmed`}
            n={kpis.n}
          />
        </div>
      )}
      <LoadChart data={chartData} />
    </main>
  );
}

function KpiCard({
  label,
  value,
  n,
}: {
  label: string;
  value: string;
  n: number;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        {value}
      </p>
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
        baseline oficial — {n.toLocaleString("pt-BR")} horas comparadas
      </p>
    </div>
  );
}
