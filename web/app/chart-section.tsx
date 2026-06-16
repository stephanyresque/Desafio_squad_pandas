"use client";

import { useMemo, useState } from "react";

import LoadChart, { type LoadChartPoint } from "./load-chart";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_PT = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

type ShortcutId = "7d" | "30d" | "90d" | "6m" | "all";

const SHORTCUTS: { id: ShortcutId; label: string }[] = [
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "90d", label: "90 dias" },
  { id: "6m", label: "6 meses" },
  { id: "all", label: "Tudo" },
];

const DEFAULT_SHORTCUT: ShortcutId = "30d";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// epoch → "YYYY-MM-DD" no fuso local (usado nos <input type="date">)
function toDateInputValue(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Janela de um atalho, ANCORADA no último timestamp dos dados (não em hoje —
// a série do ONS é defasada; usar new Date() deixaria o gráfico vazio).
function shortcutWindow(
  id: ShortcutId,
  firstEpoch: number,
  lastEpoch: number,
): { from: number; to: number } {
  if (id === "all") return { from: firstEpoch, to: lastEpoch };
  if (id === "6m") {
    const d = new Date(lastEpoch);
    d.setMonth(d.getMonth() - 6);
    return { from: d.getTime(), to: lastEpoch };
  }
  const days = id === "7d" ? 7 : id === "30d" ? 30 : 90;
  return { from: lastEpoch - days * DAY_MS, to: lastEpoch };
}

function dayStart(value: string, fallback: number): number {
  const e = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(e) ? fallback : e;
}

function dayEnd(value: string, fallback: number): number {
  const e = Date.parse(`${value}T23:59:59.999`);
  return Number.isNaN(e) ? fallback : e;
}

// Eixo X adaptativo: horas em janelas curtas, dias em médias, mês/ano em longas.
function axisConfig(spanDays: number): {
  format: (ts: string) => string;
  minTickGap: number;
} {
  if (spanDays <= 2) {
    return {
      format: (ts) => {
        const d = new Date(ts);
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:00`;
      },
      minTickGap: 40,
    };
  }
  if (spanDays <= 92) {
    return {
      format: (ts) => {
        const d = new Date(ts);
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
      },
      minTickGap: 28,
    };
  }
  return {
    format: (ts) => {
      const d = new Date(ts);
      return `${MONTHS_PT[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`;
    },
    minTickGap: 48,
  };
}

export default function ChartSection({
  data,
  modelAvailable = true,
}: {
  data: LoadChartPoint[];
  modelAvailable?: boolean;
}) {
  const firstEpoch = data.length ? Date.parse(data[0].ts) : 0;
  const lastEpoch = data.length ? Date.parse(data[data.length - 1].ts) : 0;

  const [shortcut, setShortcut] = useState<ShortcutId | null>(DEFAULT_SHORTCUT);
  const initial = shortcutWindow(DEFAULT_SHORTCUT, firstEpoch, lastEpoch);
  const [fromValue, setFromValue] = useState(() => toDateInputValue(initial.from));
  const [toValue, setToValue] = useState(() => toDateInputValue(initial.to));

  function applyShortcut(id: ShortcutId) {
    const win = shortcutWindow(id, firstEpoch, lastEpoch);
    setShortcut(id);
    setFromValue(toDateInputValue(win.from));
    setToValue(toDateInputValue(win.to));
  }

  // Datas customizadas sobrepõem o atalho (desmarcam o destaque).
  function onFromChange(value: string) {
    setShortcut(null);
    setFromValue(value);
  }
  function onToChange(value: string) {
    setShortcut(null);
    setToValue(value);
  }

  const { from, to } = useMemo(() => {
    if (shortcut) return shortcutWindow(shortcut, firstEpoch, lastEpoch);
    let f = dayStart(fromValue, firstEpoch);
    let t = dayEnd(toValue, lastEpoch);
    if (f > t) [f, t] = [t, f]; // "De" > "Até": inverte graciosamente
    // Clamp à janela disponível (do modelo) — o usuário não navega além dela.
    f = Math.min(Math.max(f, firstEpoch), lastEpoch);
    t = Math.min(Math.max(t, firstEpoch), lastEpoch);
    return { from: f, to: t };
  }, [shortcut, fromValue, toValue, firstEpoch, lastEpoch]);

  const filtered = useMemo(
    () =>
      data.filter((p) => {
        const e = Date.parse(p.ts);
        return e >= from && e <= to;
      }),
    [data, from, to],
  );

  const axis = useMemo(() => axisConfig((to - from) / DAY_MS), [from, to]);

  const baseBtn =
    "rounded-md border px-3 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400";
  const activeBtn = "border-[#550899] bg-[#550899] text-white";
  const idleBtn =
    "border-zinc-200 text-zinc-700 hover:border-zinc-400 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-600";

  return (
    <div className="w-full">
      <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Carga: real × programada ONS × modelo (MWmed)
      </h2>

      {!modelAvailable && (
        <p className="mb-4 text-xs text-amber-600 dark:text-amber-500">
          Previsões do modelo indisponíveis para este subsistema, exibindo real ×
          programada ONS.
        </p>
      )}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {SHORTCUTS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={shortcut === s.id}
              onClick={() => applyShortcut(s.id)}
              className={`${baseBtn} ${shortcut === s.id ? activeBtn : idleBtn}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="range-from"
              className="text-xs font-medium text-zinc-500 dark:text-zinc-400"
            >
              De
            </label>
            <input
              id="range-from"
              type="date"
              value={fromValue}
              min={toDateInputValue(firstEpoch)}
              max={toDateInputValue(lastEpoch)}
              onChange={(e) => onFromChange(e.target.value)}
              className="rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-sm text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:text-zinc-200 [color-scheme:light] dark:[color-scheme:dark]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="range-to"
              className="text-xs font-medium text-zinc-500 dark:text-zinc-400"
            >
              Até
            </label>
            <input
              id="range-to"
              type="date"
              value={toValue}
              min={toDateInputValue(firstEpoch)}
              max={toDateInputValue(lastEpoch)}
              onChange={(e) => onToChange(e.target.value)}
              className="rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-sm text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:text-zinc-200 [color-scheme:light] dark:[color-scheme:dark]"
            />
          </div>
        </div>
      </div>

      {filtered.length > 0 ? (
        <LoadChart
          data={filtered}
          xTickFormatter={axis.format}
          xMinTickGap={axis.minTickGap}
          showModel={modelAvailable}
        />
      ) : (
        <div className="flex h-[420px] w-full items-center justify-center rounded-lg border border-dashed border-zinc-200 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Sem dados neste intervalo.
        </div>
      )}
    </div>
  );
}
