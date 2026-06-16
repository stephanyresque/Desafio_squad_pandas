import { createClient } from "@/lib/supabase";
import { brEpoch, brFields, brHourKey, HOUR_MS } from "@/lib/forecast/features";

import { type LoadChartPoint } from "./load-chart";
import ChartSection from "./chart-section";
import LiveForecast from "./live-forecast";
import SubsystemSelector, { type SubsystemOption } from "./subsystem-selector";
import KpiCards, { type MetricTriple } from "./kpi-cards";
import SubsystemsCompare, { type SubsystemMape } from "./subsystems-compare";
import ErrorBreakdown from "./error-breakdown";
import ResidualsHistogram from "./residuals-histogram";

export const dynamic = "force-dynamic";

type SeriesRow = { ts: string; load_mw: number | string };

// Mescla real, programada ONS e modelo (LightGBM) por timestamp.
function combineSeries(
  actualRows: SeriesRow[],
  forecastRows: SeriesRow[],
  modelRows: SeriesRow[],
): LoadChartPoint[] {
  const byTs = new Map<string, LoadChartPoint>();
  const ensure = (ts: string): LoadChartPoint => {
    let point = byTs.get(ts);
    if (!point) {
      point = { ts, verificada: null, programada: null, modelo: null };
      byTs.set(ts, point);
    }
    return point;
  };

  for (const row of actualRows) ensure(row.ts).verificada = Number(row.load_mw);
  for (const row of forecastRows) ensure(row.ts).programada = Number(row.load_mw);
  for (const row of modelRows) ensure(row.ts).modelo = Number(row.load_mw);

  return Array.from(byTs.values()).sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
}

// Série COMPLETA de uma tabela (real/programada) p/ o gráfico. O PostgREST do
// Supabase limita cada resposta (db-max-rows, ~1000); paginamos com .range() até
// esgotar — assim o gráfico recebe todo o histórico, e a filtragem por intervalo
// é feita no cliente. (Os KPIs continuam na consulta limitada, intocada.)
const PAGE_SIZE = 1000;

async function fetchAllRows(
  supabase: ReturnType<typeof createClient>,
  table: "load_actual" | "load_official_forecast",
  codigo: string,
): Promise<{ ts: string; load_mw: number | string }[]> {
  const out: { ts: string; load_mw: number | string }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select("ts, load_mw, subsystems!inner(codigo)")
      .eq("subsystems.codigo", codigo)
      .order("ts", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { ts: string; load_mw: number | string }[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

// Previsões horárias de um modelo (ex.: lgbm_v1_SECO) — paginadas, ordenadas por
// target_ts. Identifica o modelo pelo model_name (join em model_runs). Em caso de
// erro retorna o que já tem (vazio dispara o fallback de 2 linhas no gráfico).
async function fetchModelPredictions(
  supabase: ReturnType<typeof createClient>,
  modelName: string,
): Promise<{ ts: string; load_mw: number | string }[]> {
  const out: { ts: string; load_mw: number | string }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("predictions")
      .select("target_ts, predicted_mw, model_runs!inner(model_name)")
      .eq("model_runs.model_name", modelName)
      .order("target_ts", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) break;
    const rows = (data ?? []) as {
      target_ts: string;
      predicted_mw: number | string;
    }[];
    for (const row of rows) out.push({ ts: row.target_ts, load_mw: row.predicted_mw });
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
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
  naive: "Sazonal simples",
  ridge: "Ridge",
  lgbm: "LightGBM",
  ons: "Programada ONS",
};
const METRICS = ["mape", "mae", "rmse"] as const;

const NAIVE_TOOLTIP =
  "Previsão de referência mais básica: assume que a carga de cada hora será igual à da mesma hora da semana anterior (t−168h). Serve de piso: qualquer modelo útil precisa errar menos que ela.";

// Tooltip só com CSS (hover + foco) — sem lib externa, funciona em Server Component.
// O gatilho é focável por teclado e leva o texto como nome acessível.
function LabelWithTooltip({
  label,
  tooltip,
}: {
  label: string;
  tooltip: string;
}) {
  return (
    <span className="group relative inline-flex items-center gap-1">
      {label}
      <button
        type="button"
        aria-label={tooltip}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-300 text-[10px] font-medium leading-none text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
      >
        ?
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-10 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-2 text-xs font-normal text-zinc-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      >
        {tooltip}
      </span>
    </span>
  );
}

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

// MAPE (lgbm × ons) dos 4 subsistemas de uma vez — para o painel comparativo
// (independente do dropdown). Mesma fonte da tabela: evaluations, backtest 12 meses.
const SUBSYSTEM_ORDER = ["SECO", "S", "NE", "N"];

async function fetchSubsystemsMape(
  supabase: ReturnType<typeof createClient>,
): Promise<SubsystemMape[]> {
  const { data } = await supabase
    .from("evaluations")
    .select("predictor, value, subsystems!inner(codigo, nome)")
    .eq("metric", "mape")
    .in("predictor", ["lgbm", "ons"]);

  const rows = (data ?? []) as unknown as {
    predictor: string;
    value: number | string;
    subsystems: JoinedSub | JoinedSub[];
  }[];

  const byCodigo = new Map<string, SubsystemMape>();
  for (const row of rows) {
    const sub = normalizeJoined(row.subsystems);
    if (!sub) continue;
    const entry =
      byCodigo.get(sub.codigo) ??
      { codigo: sub.codigo, nome: sub.nome, lgbm: null, ons: null };
    if (row.predictor === "lgbm") entry.lgbm = Number(row.value);
    if (row.predictor === "ons") entry.ons = Number(row.value);
    byCodigo.set(sub.codigo, entry);
  }

  return SUBSYSTEM_ORDER.map((c) => byCodigo.get(c)).filter(
    (e): e is SubsystemMape => e != null,
  );
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
        Sem avaliação de teste retroativo para este subsistema ainda.
      </p>
    );
  }

  // Melhor (menor) valor por COLUNA — destaque de célula, não de linha.
  const bestByMetric: Record<string, string | null> = {};
  for (const metric of METRICS) {
    let bestP: string | null = null;
    let bestV = Infinity;
    for (const p of rows) {
      const v = byPredictor[p]?.[metric];
      if (v != null && v < bestV) {
        bestV = v;
        bestP = p;
      }
    }
    bestByMetric[metric] = bestP;
  }

  const hl =
    "bg-[#AAF766]/40 font-semibold text-zinc-900 dark:bg-[#AAF766]/15 dark:text-[#AAF766]";
  const cell = (p: string, metric: string, base: string) =>
    `${base} tabular-nums${bestByMetric[metric] === p ? ` ${hl}` : ""}`;

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Comparação de modelos
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Cada modelo foi simulado prevendo a carga do dia seguinte, dia após dia, ao longo
        de 12 meses, como em produção, e comparado com o que de fato aconteceu (previsão de{" "}
        {horizonH ?? 24} horas à frente). Todos avaliados exatamente nas mesmas horas.
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Esta tabela é fixa (período de teste de 12 meses) e não muda com o seletor de
        intervalo do gráfico.
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
              return (
                <tr
                  key={p}
                  className="border-b border-zinc-100 dark:border-zinc-900"
                >
                  <td className="py-1.5 pr-4">
                    {p === "naive" ? (
                      <LabelWithTooltip
                        label={PREDICTOR_LABEL.naive}
                        tooltip={NAIVE_TOOLTIP}
                      />
                    ) : (
                      (PREDICTOR_LABEL[p] ?? p)
                    )}
                  </td>
                  <td className={cell(p, "mape", "py-1.5 pr-4")}>{pct(m.mape)}</td>
                  <td className={cell(p, "mae", "py-1.5 pr-4")}>{mwmed(m.mae)}</td>
                  <td className={cell(p, "rmse", "py-1.5")}>{mwmed(m.rmse)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Em cada coluna, a célula destacada é o menor erro (melhor). Menor é melhor nas
        três métricas.
      </p>

      {(skillNaive != null || skillOns != null) && (
        <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
          Ganho do LightGBM (redução de MAPE):{" "}
          {skillNaive != null && (
            <span className="font-medium">
              {pct(skillNaive, 1)} vs sazonal simples
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

// Linha de evaluations (mape/mae/rmse) → MetricTriple, ou null se incompleta.
function toTriple(m: Record<string, number> | undefined): MetricTriple | null {
  if (!m || m.mape == null || m.mae == null || m.rmse == null) return null;
  return { mape: m.mape, mae: m.mae, rmse: m.rmse };
}

// ---------------------------------------------------------------------------
// Dia ancorado da previsão ao vivo = o ÚLTIMO dia COMPLETO de verificada (não o
// seguinte). Assim há carga real para sobrepor previsto × real. Continua day-ahead
// sem vazamento: a rota /api/forecast só usa features com piso de 24h (≤ fim de D−1).
// ---------------------------------------------------------------------------
function anchoredForecastDate(maxActualTs: string | null): string | null {
  if (!maxActualTs) return null;
  const maxEpoch = Date.parse(maxActualTs);
  const f = brFields(maxEpoch);
  let lastComplete = brEpoch(f.year, f.month, f.day, 0); // meia-noite do dia do maxTs
  if (f.hour < 23) lastComplete -= 24 * HOUR_MS; // dia ainda incompleto → usa o anterior
  return brHourKey(lastComplete).slice(0, 10);
}

// Carga verificada (real) das 24h do dia ancorado, indexada pela hora-rótulo
// (mesmo formato dos target_ts da /api/forecast) — para o overlay previsto × real.
function realForDate(
  fullActual: SeriesRow[],
  targetDate: string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!targetDate) return out;
  for (const row of fullActual) {
    const key = brHourKey(Date.parse(row.ts));
    if (key.slice(0, 10) === targetDate) out[key] = Number(row.load_mw);
  }
  return out;
}

// Cabeçalho de seção da narrativa: título + subtítulo.
function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
      <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        {title}
      </h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>
    </div>
  );
}

// Seções da narrativa — usadas pela navegação âncora e pelos ids das <section>.
const SECTIONS = [
  { id: "panorama", label: "Panorama geral" },
  { id: "qualidade", label: "Qualidade do modelo" },
  { id: "metodologia", label: "Metodologia" },
  { id: "confiabilidade", label: "Confiabilidade" },
  { id: "predicao", label: "Predição do dia seguinte" },
] as const;

// Navegação fixa: clicar leva direto à seção (âncoras + rolagem suave via CSS).
function SectionNav() {
  return (
    <nav
      aria-label="Seções"
      className="sticky top-0 z-20 -mx-6 mb-2 mt-6 border-b border-zinc-200 bg-white/80 px-6 py-2.5 backdrop-blur dark:border-white/10 dark:bg-[#161022]/80"
    >
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="text-zinc-500 transition-colors hover:text-[#550899] dark:text-zinc-400 dark:hover:text-[#AC4DFF]"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
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

  const lgbmName = `lgbm_v1_${selected}`;
  const ridgeName = `ridge_v1_${selected}`; // run de BACKTEST do Ridge (não o served)

  const [
    comparison,
    maxActualResult,
    fullActual,
    fullForecast,
    modelRows,
    subsystemsMape,
    ridgeRows,
  ] = await Promise.all([
    fetchComparison(supabase, selected),
    supabase
      .from("load_actual")
      .select("ts, subsystems!inner(codigo)")
      .eq("subsystems.codigo", selected)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Histórico completo (paginado): real e programada para o gráfico.
    fetchAllRows(supabase, "load_actual", selected),
    fetchAllRows(supabase, "load_official_forecast", selected),
    // Previsões horárias do LightGBM — definem a janela do gráfico.
    fetchModelPredictions(supabase, lgbmName),
    // MAPE dos 4 subsistemas (independente do dropdown) para o painel comparativo.
    fetchSubsystemsMape(supabase),
    // Previsões de BACKTEST do Ridge — base da banda de incerteza da previsão ao vivo.
    fetchModelPredictions(supabase, ridgeName),
  ]);

  // Janela do gráfico = [min, max] das previsões do modelo (sem hardcode). Real e
  // programada ficam recortadas à MESMA janela. Sem previsões → fallback 2 linhas.
  const modelAvailable = modelRows.length > 0;
  let winMin = Infinity;
  let winMax = -Infinity;
  for (const row of modelRows) {
    const e = Date.parse(row.ts);
    if (e < winMin) winMin = e;
    if (e > winMax) winMax = e;
  }

  const combined = combineSeries(fullActual, fullForecast, modelRows);
  const chartData = modelAvailable
    ? combined.filter((p) => {
        const e = Date.parse(p.ts);
        return e >= winMin && e <= winMax;
      })
    : combined;

  // KPIs do melhor modelo (LightGBM) + referência ONS — MESMA fonte da tabela.
  const lgbm = toTriple(comparison.byPredictor.lgbm);
  const ons = toTriple(comparison.byPredictor.ons);

  const maxActualTs = (maxActualResult.data as { ts: string } | null)?.ts ?? null;
  const targetDate = anchoredForecastDate(maxActualTs);
  const realByTs = realForDate(fullActual, targetDate);

  // Resíduos do Ridge (backtest) por hora do dia (Brasília) → base da banda de incerteza.
  // O join real×previsto é feito aqui no servidor; os QUANTIS são calculados no cliente.
  const actualByEpoch = new Map<number, number>();
  for (const row of fullActual) actualByEpoch.set(Date.parse(row.ts), Number(row.load_mw));
  const residualsByHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of ridgeRows) {
    const epoch = Date.parse(p.ts);
    const real = actualByEpoch.get(epoch);
    if (real == null) continue;
    residualsByHour[brFields(epoch).hour].push(Math.round(real - Number(p.load_mw)));
  }

  // Cartão que agrupa um par de painéis num capítulo (fundo/borda sutil).
  const groupCard =
    "mt-6 rounded-xl border border-zinc-200 bg-zinc-50/60 p-5 dark:border-zinc-800 dark:bg-zinc-900/40";

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      {/* Cabeçalho da página */}
      <header>
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#550899]">
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="#AAF766"
              aria-hidden="true"
            >
              <path d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" />
            </svg>
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Previsão de carga do Sistema Interligado Nacional
          </h1>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Previsão da carga elétrica brasileira, por subsistema
        </p>
        <div className="mt-5">
          <SubsystemSelector options={options} value={selected} />
        </div>
      </header>

      <SectionNav />

      {/* Panorama geral */}
      <section id="panorama" className="mt-12 scroll-mt-20">
        <SectionHeader
          title="Panorama geral"
          subtitle="A carga real de cada hora, a previsão oficial do ONS e a do melhor modelo."
        />
        <div className="mt-6">
          <ChartSection
            key={selected}
            data={chartData}
            modelAvailable={modelAvailable}
          />
        </div>
      </section>

      {/* Qualidade do modelo */}
      <section id="qualidade" className="mt-16 scroll-mt-20">
        <SectionHeader
          title="Qualidade do modelo"
          subtitle="O resumo das três métricas principais."
        />
        <div className="mt-6">{lgbm && <KpiCards metrics={lgbm} ons={ons} />}</div>
      </section>

      {/* Metodologia */}
      <section id="metodologia" className="mt-16 scroll-mt-20">
        <SectionHeader
          title="Metodologia"
          subtitle="A escada de modelos e comparações."
        />
        <div className={`${groupCard} grid gap-8 lg:grid-cols-2`}>
          <ComparisonPanel comparison={comparison} />
          <SubsystemsCompare data={subsystemsMape} />
        </div>
      </section>

      {/* Confiabilidade */}
      <section id="confiabilidade" className="mt-16 scroll-mt-20">
        <SectionHeader
          title="Confiabilidade"
          subtitle="Auditoria do modelo: onde o erro se concentra e como ele se distribui."
        />
        <div className={`${groupCard} space-y-8`}>
          <ErrorBreakdown key={`erro-${selected}`} data={chartData} />
          <ResidualsHistogram key={`hist-${selected}`} data={chartData} />
        </div>
      </section>

      {/* Predição do dia seguinte */}
      <section id="predicao" className="mt-16 scroll-mt-20">
        <SectionHeader
          title="Predição do dia seguinte"
          subtitle="A previsão para o dia seguinte calculada na hora pelo modelo Ridge, com a faixa de confiança."
        />
        <div className="mt-6">
          <LiveForecast
            subsystem={selected}
            targetDate={targetDate}
            realByTs={realByTs}
            residualsByHour={residualsByHour}
          />
        </div>
      </section>
    </main>
  );
}

