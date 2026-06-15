import { createClient } from "@/lib/supabase";
import { brEpoch, brFields, brHourKey, HOUR_MS } from "@/lib/forecast/features";

import LoadChart, { type LoadChartPoint } from "./load-chart";
import LiveForecast from "./live-forecast";
import SubsystemSelector, { type SubsystemOption } from "./subsystem-selector";

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

// ---------------------------------------------------------------------------
// Subsistemas com avaliação (DISTINCT em evaluations) — popula o seletor
// ---------------------------------------------------------------------------
type JoinedSub = { codigo: string; nome: string };

function normalizeJoined(value: JoinedSub | JoinedSub[] | null): JoinedSub | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function fetchSubsystemOptions(
  supabase: ReturnType<typeof createClient>,
): Promise<SubsystemOption[]> {
  const { data } = await supabase
    .from("evaluations")
    .select("subsystem_id, subsystems!inner(codigo, nome)");

  const rows = (data ?? []) as unknown as {
    subsystem_id: number;
    subsystems: JoinedSub | JoinedSub[];
  }[];

  const byCodigo = new Map<string, SubsystemOption>();
  for (const row of rows) {
    const sub = normalizeJoined(row.subsystems);
    if (sub) byCodigo.set(sub.codigo, { codigo: sub.codigo, nome: sub.nome });
  }
  return Array.from(byCodigo.values()).sort((a, b) =>
    a.codigo.localeCompare(b.codigo),
  );
}

// ---------------------------------------------------------------------------
// Painel de comparação — backtest walk-forward (tabela evaluations)
// ---------------------------------------------------------------------------
const PREDICTOR_ORDER = ["naive", "ridge", "lgbm", "ons"] as const;
const PREDICTOR_LABEL: Record<string, string> = {
  naive: "Ingênuo sazonal",
  ridge: "Ridge",
  lgbm: "LightGBM",
  ons: "Programada ONS",
};
const METRICS = ["mape", "mae", "rmse"] as const;

type Comparison = {
  byPredictor: Record<string, Record<string, number>>;
  horizonH: number | null;
};

async function fetchComparison(
  supabase: ReturnType<typeof createClient>,
  codigo: string,
): Promise<Comparison> {
  const { data } = await supabase
    .from("evaluations")
    .select("predictor, metric, value, horizon_h, subsystems!inner(codigo)")
    .eq("subsystems.codigo", codigo);

  const rows = (data ?? []) as unknown as {
    predictor: string;
    metric: string;
    value: number | string;
    horizon_h: number;
  }[];

  const byPredictor: Record<string, Record<string, number>> = {};
  let horizonH: number | null = null;
  for (const row of rows) {
    (byPredictor[row.predictor] ??= {})[row.metric] = Number(row.value);
    horizonH = row.horizon_h;
  }
  return { byPredictor, horizonH };
}

function pct(value: number, digits = 2): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function mwmed(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

function ComparisonPanel({ comparison }: { comparison: Comparison }) {
  const { byPredictor, horizonH } = comparison;
  const lgbm = byPredictor.lgbm;
  const naive = byPredictor.naive;
  const ons = byPredictor.ons;

  const skill = (base?: Record<string, number>) =>
    base && lgbm && base.mape ? ((base.mape - lgbm.mape) / base.mape) * 100 : null;
  const skillNaive = skill(naive);
  const skillOns = skill(ons);

  const rows = PREDICTOR_ORDER.filter((p) => byPredictor[p]);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Sem avaliação de backtest para este subsistema ainda.
      </p>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Comparação de modelos
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Backtest walk-forward — 12 meses de teste, horizonte {horizonH ?? 24}h.
        Avaliação nas MESMAS horas (diferente dos KPIs acima, que são da janela visível
        do gráfico).
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="py-1 pr-4 font-medium">Preditor</th>
              <th className="py-1 pr-4 font-medium">MAPE %</th>
              <th className="py-1 pr-4 font-medium">MAE (MWmed)</th>
              <th className="py-1 font-medium">RMSE (MWmed)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const m = byPredictor[p];
              const isBest = p === "lgbm";
              return (
                <tr
                  key={p}
                  className={
                    isBest
                      ? "border-b border-zinc-100 bg-green-50 font-semibold dark:border-zinc-900 dark:bg-green-950/40"
                      : "border-b border-zinc-100 dark:border-zinc-900"
                  }
                >
                  <td className="py-1.5 pr-4">
                    {PREDICTOR_LABEL[p] ?? p}
                    {isBest && (
                      <span className="ml-2 rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        melhor modelo
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums">{pct(m.mape)}</td>
                  <td className="py-1.5 pr-4 tabular-nums">{mwmed(m.mae)}</td>
                  <td className="py-1.5 tabular-nums">{mwmed(m.rmse)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(skillNaive != null || skillOns != null) && (
        <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
          Skill do LightGBM (redução de MAPE):{" "}
          {skillNaive != null && (
            <span className="font-medium">
              {pct(skillNaive, 1)} vs ingênuo
            </span>
          )}
          {skillNaive != null && skillOns != null && " · "}
          {skillOns != null && (
            <span className="font-medium">
              {skillOns >= 0 ? pct(skillOns, 1) : `${pct(skillOns, 1)}`} vs ONS
            </span>
          )}
          {skillOns != null && skillOns < 0 && (
            <span className="text-zinc-500"> (ONS ainda à frente)</span>
          )}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// D+1 sugerido = dia seguinte ao último dia COMPLETO de verificada (precisa do
// histórico até a hora 23:00 do dia anterior ao alvo).
// ---------------------------------------------------------------------------
function suggestedTargetDate(maxActualTs: string | null): string | null {
  if (!maxActualTs) return null;
  const maxEpoch = Date.parse(maxActualTs);
  const f = brFields(maxEpoch);
  let lastComplete = brEpoch(f.year, f.month, f.day, 0); // meia-noite do dia do maxTs
  if (f.hour < 23) lastComplete -= 24 * HOUR_MS; // dia ainda incompleto → usa o anterior
  return brHourKey(lastComplete + 24 * HOUR_MS).slice(0, 10);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ sub?: string }>;
}) {
  const sp = await searchParams;
  const supabase = createClient();

  const options = await fetchSubsystemOptions(supabase);
  const selected =
    options.find((o) => o.codigo === sp.sub)?.codigo ??
    options[0]?.codigo ??
    "SECO";

  const [actualResult, forecastResult, comparison, maxActualResult] =
    await Promise.all([
      supabase
        .from("load_actual")
        .select("ts, load_mw, subsystems!inner(codigo)")
        .eq("subsystems.codigo", selected)
        .order("ts", { ascending: true }),
      supabase
        .from("load_official_forecast")
        .select("ts, load_mw, subsystems!inner(codigo)")
        .eq("subsystems.codigo", selected)
        .order("ts", { ascending: true }),
      fetchComparison(supabase, selected),
      supabase
        .from("load_actual")
        .select("ts, subsystems!inner(codigo)")
        .eq("subsystems.codigo", selected)
        .order("ts", { ascending: false })
        .limit(1)
        .maybeSingle(),
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
  const maxActualTs = (maxActualResult.data as { ts: string } | null)?.ts ?? null;
  const targetDate = suggestedTargetDate(maxActualTs);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10">
      <div className="mb-6">
        <SubsystemSelector options={options} value={selected} />
      </div>

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

      <div className="mt-10">
        <ComparisonPanel comparison={comparison} />
      </div>

      <LiveForecast subsystem={selected} targetDate={targetDate} />
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
