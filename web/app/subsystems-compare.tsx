"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type SubsystemMape = {
  codigo: string;
  nome: string;
  lgbm: number | null;
  ons: number | null;
};

const MODEL_COLOR = "#AC4DFF"; // roxo — coerente com a linha do modelo no gráfico principal
const ONS_COLOR = "#FF6A00"; // laranja — coerente com a programada ONS
const WIN_COLOR = "#AAF766"; // verde claro — destaque do vencedor (maior valor em foco)

function pct(value: number): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

// "A", "A e B", "A, B e C"
function listPt(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

export default function SubsystemsCompare({ data }: { data: SubsystemMape[] }) {
  if (data.length === 0) {
    return null;
  }

  const chartData = data.map((d) => ({
    name: d.nome,
    modelo: d.lgbm,
    ons: d.ons,
    // vencedor = menor MAPE (dinâmico); só decide quando há os dois valores.
    winner:
      d.lgbm != null && d.ons != null
        ? d.lgbm < d.ons
          ? "modelo"
          : "ons"
        : null,
  }));

  const comparable = data.filter((d) => d.lgbm != null && d.ons != null);
  const wins = comparable.filter((d) => (d.lgbm as number) < (d.ons as number));
  const summary =
    wins.length > 0
      ? `O modelo supera o ONS em ${wins.length} das ${comparable.length} regiões (${listPt(
          wins.map((d) => d.nome),
        )}).`
      : `Nas ${comparable.length} regiões avaliadas, a programada do ONS ainda tem MAPE menor que o do modelo.`;

  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Comparativo dos subsistemas
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        MAPE do melhor modelo (LightGBM) × programada ONS nas 4 regiões, no teste
        retroativo de 12 meses. Só o MAPE é usado porque, sendo percentual, é comparável
        entre regiões de tamanhos muito diferentes (N ~8 GW, SE/CO ~45 GW).
      </p>

      <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{summary}</p>

      <div className="mt-3">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart
            data={chartData}
            margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
            barGap={4}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
            <XAxis
              dataKey="name"
              interval={0}
              tick={{ fontSize: 12, fill: "#71717a" }}
            />
            <YAxis
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 11, fill: "#71717a" }}
              width={44}
            />
            <Tooltip
              formatter={(v, name) => [
                v == null ? "—" : pct(Number(v)),
                String(name),
              ]}
            />
            <Legend />
            <Bar dataKey="modelo" name="Modelo (LightGBM)" fill={MODEL_COLOR} radius={[2, 2, 0, 0]}>
              {chartData.map((d) => (
                <Cell
                  key={d.name}
                  stroke={d.winner === "modelo" ? WIN_COLOR : "none"}
                  strokeWidth={d.winner === "modelo" ? 2.5 : 0}
                />
              ))}
            </Bar>
            <Bar dataKey="ons" name="ONS" fill={ONS_COLOR} radius={[2, 2, 0, 0]}>
              {chartData.map((d) => (
                <Cell
                  key={d.name}
                  stroke={d.winner === "ons" ? WIN_COLOR : "none"}
                  strokeWidth={d.winner === "ons" ? 2.5 : 0}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Borda verde = menor MAPE (vencedor) em cada região.
      </p>
    </section>
  );
}
