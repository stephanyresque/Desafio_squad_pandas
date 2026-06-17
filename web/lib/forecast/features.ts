// Engenharia de features em TS — espelha EXATAMENTE pipeline/model.py (build_features).
// É a ÚNICA fonte usada pela rota /api/forecast e pelo teste de paridade.
// PISO DE 24h: para a hora-alvo t, nenhuma feature de carga toca dado em (t−24h, t].
// Tempo: Brasília é UTC−3 fixo; derivamos o calendário deslocando −3h sobre o epoch.

export const HOUR_MS = 60 * 60 * 1000;
const BR_OFFSET_MS = 3 * HOUR_MS;

type BrFields = {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number; // 0..23
  dow: number; // segunda=0 .. domingo=6 (igual ao pandas)
};

export function brFields(epochMs: number): BrFields {
  const d = new Date(epochMs - BR_OFFSET_MS); // campos UTC == relógio de Brasília
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    dow: (d.getUTCDay() + 6) % 7, // JS domingo=0 → segunda=0
  };
}

// epoch ms da hora `hour` do dia (ano/mês/dia) em Brasília (UTC−3 fixo).
export function brEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
): number {
  return Date.UTC(year, month - 1, day, hour) + BR_OFFSET_MS;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function brHourKey(epochMs: number): string {
  const f = brFields(epochMs);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:00:00-03:00`;
}

export function brDateKey(epochMs: number): string {
  const f = brFields(epochMs);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// dia-do-ano 1-based, igual a pandas DatetimeIndex.dayofyear
export function dayOfYear(year: number, month: number, day: number): number {
  let doy = CUM_DAYS[month - 1] + day;
  if (month > 2 && isLeap(year)) doy += 1;
  return doy;
}

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Desvio amostral (ddof=1) — igual ao padrão de pandas .rolling().std()
function sampleStd(values: number[]): number {
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

export type ActualLookup = (epochMs: number) => number | undefined;

export type FeatureResult =
  | { ok: true; features: Record<string, number> }
  | { ok: false; missingOffsetsH: number[] };

// Computa as 20 features para a hora-alvo `targetEpoch`, lendo a carga verificada
// via `getActual` (chave = epoch ms da hora em Brasília). Retorna os offsets ausentes
// se faltar qualquer hora necessária — o chamador decide o erro (não inventa valor).
export function computeFeatureMap(
  targetEpoch: number,
  getActual: ActualLookup,
  holidaySet: Set<string>,
): FeatureResult {
  // Bloco contínuo de carga: offsets 24..191h antes de t (união do que as features veem).
  const block: number[] = [];
  const missing: number[] = [];
  for (let off = 24; off <= 191; off++) {
    const v = getActual(targetEpoch - off * HOUR_MS);
    if (v === undefined) missing.push(off);
    else block.push(v);
  }
  if (missing.length > 0) {
    return { ok: false, missingOffsetsH: missing };
  }

  // block[k] corresponde ao offset (24 + k). Índices relativos:
  const at = (off: number) => block[off - 24];

  const roll24 = block.slice(0, 24); // offsets 24..47
  const roll7d = block; // offsets 24..191 (168 valores)
  const sameHour = [24, 48, 72, 96, 120, 144, 168].map(at);

  const f = brFields(targetEpoch);
  const doy = dayOfYear(f.year, f.month, f.day);

  const features: Record<string, number> = {
    // Carga (todas com piso de 24h)
    lag_24: at(24),
    lag_48: at(48),
    lag_168: at(168),
    roll_mean_24: mean(roll24),
    roll_std_24: sampleStd(roll24),
    roll_mean_7d: mean(roll7d),
    roll_std_7d: sampleStd(roll7d),
    same_hour_mean_7d: mean(sameHour),
    // Calendário determinístico
    hour: f.hour,
    dow: f.dow,
    month: f.month,
    is_weekend: f.dow >= 5 ? 1 : 0,
    is_holiday: holidaySet.has(brDateKey(targetEpoch)) ? 1 : 0,
    is_pre_holiday: holidaySet.has(brDateKey(targetEpoch + 24 * HOUR_MS)) ? 1 : 0,
    // Fourier
    sin_hour: Math.sin((2 * Math.PI * f.hour) / 24),
    cos_hour: Math.cos((2 * Math.PI * f.hour) / 24),
    sin_dow: Math.sin((2 * Math.PI * f.dow) / 7),
    cos_dow: Math.cos((2 * Math.PI * f.dow) / 7),
    sin_doy: Math.sin((2 * Math.PI * doy) / 365),
    cos_doy: Math.cos((2 * Math.PI * doy) / 365),
  };

  return { ok: true, features };
}

// Vetor de features na ORDEM exata do artifact (a mesma do treino Python).
export function orderFeatures(
  featureMap: Record<string, number>,
  order: string[],
): number[] {
  return order.map((name) => featureMap[name]);
}
