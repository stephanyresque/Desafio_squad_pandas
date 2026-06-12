"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type LoadChartPoint = {
  ts: string;
  verificada: number | null;
  programada: number | null;
};

type LoadChartProps = {
  data: LoadChartPoint[];
};

function formatTs(ts: string): string {
  const date = new Date(ts);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${day}/${month} ${hour}:00`;
}

function formatMw(value: number | string | null | undefined): string {
  if (value == null) {
    return "—";
  }
  return `${Number(value).toLocaleString("pt-BR")} MWmed`;
}

export default function LoadChart({ data }: LoadChartProps) {
  return (
    <div className="w-full">
      <h1 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Carga SE/CO: real × programada ONS (MWmed)
      </h1>
      <ResponsiveContainer width="100%" height={420}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis
            dataKey="ts"
            tickFormatter={formatTs}
            minTickGap={32}
            tick={{ fontSize: 11, fill: "#71717a" }}
          />
          <YAxis
            tickFormatter={(value: number) => value.toLocaleString("pt-BR")}
            tick={{ fontSize: 11, fill: "#71717a" }}
            width={72}
            label={{
              value: "MWmed",
              angle: -90,
              position: "insideLeft",
              fill: "#71717a",
              fontSize: 12,
            }}
          />
          <Tooltip
            labelFormatter={(label) => formatTs(String(label))}
            formatter={(value, name) => [formatMw(value), String(name)]}
          />
          <Legend />
          <Line
            type="monotone"
            name="Real"
            dataKey="verificada"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            connectNulls
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            name="Programada"
            dataKey="programada"
            stroke="#f59e0b"
            strokeWidth={2}
            dot={false}
            connectNulls
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
