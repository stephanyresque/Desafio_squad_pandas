import { createClient } from "@/lib/supabase";

import LoadChart, { type LoadChartPoint } from "./load-chart";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = createClient();

  const { data, error } = await supabase
    .from("load_actual")
    .select("ts, load_mw, subsystems!inner(codigo)")
    .eq("subsystems.codigo", "SECO")
    .order("ts", { ascending: true });

  if (error) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
        <p className="text-red-600">Erro ao carregar dados: {error.message}</p>
      </main>
    );
  }

  const chartData: LoadChartPoint[] = (data ?? []).map((row) => ({
    ts: row.ts,
    load_mw: Number(row.load_mw),
  }));

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
      <LoadChart data={chartData} />
    </main>
  );
}
