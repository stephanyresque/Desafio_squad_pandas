"use client";

import { useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const OBS_COLOR = "#2B60D6"; // azul — observado
const FIT_COLOR = "#AC4DFF"; // roxo — ajuste

export type SensitivityPoint = {
  temp: number;
  observed: number;
  fitted: number;
  n: number;
};

export type WeatherSensitivity = {
  balance_c: number;
  slope_cool: number;
  slope_heat: number;
  intercept: number;
  r2: number | null;
  n_days: number;
  mean_load: number | null;
  curve: SensitivityPoint[];
};

function formatMw(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

function formatPct1(value: number): string {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatTemp(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function formatTempInt(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

type TipItem = { dataKey?: string | number; value?: number | string };

function CurveTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TipItem[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const val = (k: string): number | null => {
    const it = payload.find((p) => p.dataKey === k);
    return it && it.value != null ? Number(it.value) : null;
  };
  const observed = val("observed");
  const fitted = val("fitted");

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">
        {formatTemp(Number(label))} °C
      </div>
      {observed != null && (
        <div style={{ color: OBS_COLOR }}>Observado: {formatMw(observed)} MWmed</div>
      )}
      {fitted != null && (
        <div style={{ color: FIT_COLOR }}>Ajuste: {formatMw(fitted)} MWmed</div>
      )}
    </div>
  );
}

export default function TemperatureSensitivity({
  subsystem,
  data,
}: {
  subsystem: string;
  data: WeatherSensitivity | null;
}) {
  if (!data) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Sem análise de sensibilidade para este subsistema.
      </p>
    );
  }
  // key força remontar (e resetar o cenário p/ balance_c) ao trocar de subsistema.
  return <Body key={subsystem} data={data} />;
}

function Body({ data }: { data: WeatherSensitivity }) {
  const { balance_c, slope_cool, slope_heat, intercept, r2, mean_load, curve } =
    data;

  const temps = curve.map((p) => p.temp);
  const minTemp = temps.length ? Math.min(...temps) : balance_c - 10;
  const maxTemp = temps.length ? Math.max(...temps) : balance_c + 10;

  const [simT, setSimT] = useState(balance_c);
  const fittedAt =
    intercept +
    slope_cool * Math.max(simT - balance_c, 0) +
    slope_heat * Math.max(balance_c - simT, 0);
  const delta = fittedAt - intercept;
  const isMinLoad = Math.abs(delta) < 0.5; // ≈ ponto de menor carga (balance_c)

  const pctCool = mean_load ? (slope_cool / mean_load) * 100 : null;
  const pctHeat = mean_load ? (slope_heat / mean_load) * 100 : null;
  const hasHeat = slope_heat > 5;

  return (
    <div className="mt-6 space-y-6">
      {/* 1) Manchete */}
      <div>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Cada °C de calor adiciona{" "}
          <span className="font-semibold">~{formatMw(slope_cool)} MWmed</span> à carga
          {pctCool != null && <> (~{formatPct1(pctCool)}%/°C)</>}.
          {hasHeat && (
            <>
              {" "}
              E cada °C de frio (abaixo de {formatTemp(balance_c)} °C) adiciona{" "}
              <span className="font-semibold">~{formatMw(slope_heat)} MWmed</span>
              {pctHeat != null && <> (~{formatPct1(pctHeat)}%/°C)</>}.
            </>
          )}
        </p>
        {r2 != null && (
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            R² ={" "}
            {r2.toLocaleString("pt-BR", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            — quanto da variação diária da carga a temperatura explica.
          </p>
        )}
      </div>

      {/* 2) Curva observada × ajuste */}
      <div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart
            data={curve}
            margin={{ top: 8, right: 16, left: 8, bottom: 24 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis
              dataKey="temp"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v: number) => `${formatTemp(v)}°`}
              tick={{ fontSize: 11, fill: "#71717a" }}
              label={{
                value: "Temperatura (°C)",
                position: "insideBottom",
                offset: -4,
                fill: "#71717a",
                fontSize: 12,
              }}
            />
            <YAxis
              tickFormatter={(v: number) => v.toLocaleString("pt-BR")}
              tick={{ fontSize: 11, fill: "#71717a" }}
              width={64}
              label={{
                value: "MWmed",
                angle: -90,
                position: "insideLeft",
                fill: "#71717a",
                fontSize: 12,
              }}
            />
            <Tooltip
              content={(props) => (
                <CurveTooltip
                  active={props.active}
                  payload={props.payload as unknown as TipItem[] | undefined}
                  label={props.label as string | number | undefined}
                />
              )}
            />
            <Legend wrapperStyle={{ paddingTop: 12 }} />
            <Scatter
              dataKey="observed"
              name="Carga observada (média por temperatura)"
              fill={OBS_COLOR}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="fitted"
              name="Sensibilidade estimada"
              stroke={FIT_COLOR}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 3) Cenário: atalhos + stepper */}
      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Simular temperatura
        </p>

        {/* Atalhos — linha centralizada */}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {hasHeat && (
            <ScenarioButton
              label={`Frio · ${formatTempInt(minTemp)} °C`}
              active={simT === minTemp}
              onClick={() => setSimT(minTemp)}
            />
          )}
          <ScenarioButton
            label={`Ameno · ${formatTempInt(balance_c)} °C`}
            active={simT === balance_c}
            onClick={() => setSimT(balance_c)}
          />
          <ScenarioButton
            label={`Quente · ${formatTempInt(maxTemp)} °C`}
            active={simT === maxTemp}
            onClick={() => setSimT(maxTemp)}
          />
        </div>

        {/* Slider com − e + nas pontas (passo de 0,5 °C) */}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSimT((v) => Math.max(minTemp, v - 0.5))}
            disabled={simT <= minTemp}
            aria-label="Diminuir 0,5 °C"
            className={STEP_BTN}
          >
            −
          </button>
          <input
            type="range"
            min={minTemp}
            max={maxTemp}
            step={0.5}
            value={simT}
            onChange={(e) => setSimT(Number(e.target.value))}
            aria-label="Temperatura simulada"
            className="w-full accent-[#AC4DFF]"
          />
          <button
            type="button"
            onClick={() => setSimT((v) => Math.min(maxTemp, v + 0.5))}
            disabled={simT >= maxTemp}
            aria-label="Aumentar 0,5 °C"
            className={STEP_BTN}
          >
            +
          </button>
        </div>

        {/* Valor atual */}
        <p className="mt-2 text-center text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
          {formatTempInt(simT)} °C
        </p>

        {/* Leitura */}
        <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
          A <span className="font-semibold">{formatTempInt(simT)} °C</span>, a carga
          estimada é{" "}
          <span className="font-semibold">~{formatMw(fittedAt)} MWmed</span>
          {isMinLoad ? (
            <> — o ponto de menor carga.</>
          ) : (
            <>
              {" "}
              — cerca de {formatMw(Math.abs(delta))} MWmed acima do ponto de menor
              carga ({formatTempInt(balance_c)} °C).
            </>
          )}
        </p>
      </div>
    </div>
  );
}

const STEP_BTN =
  "flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-lg leading-none text-zinc-700 transition-colors hover:border-[#AC4DFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300";

function ScenarioButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-md border px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] " +
        (active
          ? "border-[#550899] bg-[#550899] text-white"
          : "border-zinc-200 text-zinc-700 hover:border-[#AC4DFF] dark:border-zinc-800 dark:text-zinc-300")
      }
    >
      {label}
    </button>
  );
}
