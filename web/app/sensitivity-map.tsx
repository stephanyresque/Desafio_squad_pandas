"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { BRAZIL_STATES, MAP_VIEWBOX, MARKERS } from "./brazil-geo";

export type MapSensitivity = {
  codigo: string;
  nome: string;
  slope_cool_mw_per_c: number;
  slope_heat_mw_per_c: number;
  mean_load_mw: number;
};

const COOL_COLOR = "#AC4DFF"; // roxo — carga sobe no calor
const BISENS_COLOR = "#AAF766"; // verde-limão — calor e frio (Sul)

const SHORT_NAME: Record<string, string> = {
  SECO: "SE/CO",
  S: "Sul",
  NE: "Nordeste",
  N: "Norte",
};

// Lado do rótulo por subsistema (o marcador não cobre o texto).
const LABEL_SIDE: Record<string, "top" | "right" | "bottom"> = {
  N: "top", // Belém — em cima
  NE: "right", // Recife — à direita (usa a margem direita)
  SECO: "right", // SP — à direita
  S: "bottom", // POA — embaixo
};

function formatPct1(value: number): string {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export default function SensitivityMap({
  data,
  selected,
}: {
  data: MapSensitivity[];
  selected: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  function select(codigo: string) {
    if (codigo !== selected) {
      startTransition(() => router.push(`/?sub=${codigo}`));
    }
  }

  const points = data
    .filter((d) => MARKERS[d.codigo] && d.mean_load_mw > 0)
    .map((d) => {
      const sens = (d.slope_cool_mw_per_c / d.mean_load_mw) * 100; // %/°C de refrigeração
      return {
        codigo: d.codigo,
        sens,
        biSensivel: d.slope_heat_mw_per_c > 5,
        marker: MARKERS[d.codigo],
        label: `${SHORT_NAME[d.codigo] ?? d.nome} · ${formatPct1(sens)}%/°C`,
      };
    });

  const sensValues = points.map((p) => p.sens);
  const minSens = sensValues.length ? Math.min(...sensValues) : 0;
  const maxSens = sensValues.length ? Math.max(...sensValues) : 1;

  // raio: escala linear entre 6 (menor sens) e 12 (maior sens) do conjunto.
  const radiusFor = (sens: number): number =>
    maxSens === minSens ? 9 : 6 + ((sens - minSens) / (maxSens - minSens)) * 6;

  return (
    <div className="w-full">
      <svg
        viewBox={MAP_VIEWBOX}
        role="img"
        aria-label="Mapa do Brasil com a sensibilidade da carga à temperatura por subsistema"
        className="mx-auto block h-auto w-full max-w-md"
      >
        {/* Divisas dos 27 estados */}
        {BRAZIL_STATES.map((s) => (
          <path
            key={s.sigla}
            d={s.d}
            fillRule="evenodd"
            strokeWidth={0.6}
            className="fill-zinc-100 stroke-zinc-300 dark:fill-zinc-800/40 dark:stroke-zinc-700"
          />
        ))}

        {/* Marcadores por subsistema */}
        {points.map((p) => {
          const color = p.biSensivel ? BISENS_COLOR : COOL_COLOR;
          const isSel = p.codigo === selected;
          const r = radiusFor(p.sens);
          const { cx, cy } = p.marker;
          const side = LABEL_SIDE[p.codigo] ?? "right";

          let lx = cx;
          let ly = cy;
          let anchor: "start" | "middle" | "end" = "middle";
          let baseline: "middle" | "auto" = "auto";
          if (side === "right") {
            lx = cx + r + 6;
            anchor = "start";
            baseline = "middle";
          } else if (side === "top") {
            ly = cy - r - 6;
          } else {
            ly = cy + r + 14;
          }

          return (
            <g
              key={p.codigo}
              className="cursor-pointer focus:outline-none"
              role="button"
              tabIndex={0}
              aria-label={`Selecionar ${p.label}`}
              onClick={() => select(p.codigo)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(p.codigo);
                }
              }}
            >
              {isSel && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={r + 3}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeOpacity={0.9}
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                fillOpacity={isSel ? 1 : 0.85}
              />
              <text
                x={lx}
                y={ly}
                textAnchor={anchor}
                dominantBaseline={baseline}
                fontSize={11}
                className="fill-zinc-700 dark:fill-zinc-300"
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: COOL_COLOR }}
          />
          carga sobe no calor
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: BISENS_COLOR }}
          />
          carga sobe no calor e no frio (Sul)
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
        tamanho do ponto = sensibilidade (% da carga por °C)
      </p>
    </div>
  );
}
