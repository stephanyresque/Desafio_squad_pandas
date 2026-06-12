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

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
      <LoadChart data={chartData} />
    </main>
  );
}
