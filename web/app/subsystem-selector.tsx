"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export type SubsystemOption = { codigo: string; nome: string };

// Seletor de subsistema. Navega via ?sub=CODE — o server re-renderiza painel, KPIs e
// gráfico para o subsistema escolhido. As opções vêm de quem TEM linhas em evaluations,
// então o seletor cresce sozinho quando S/NE/N forem ingeridos (sem mexer em código).
export default function SubsystemSelector({
  options,
  value,
}: {
  options: SubsystemOption[];
  value: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
      <span className="font-medium">Subsistema:</span>
      <select
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        value={value}
        disabled={pending || options.length === 0}
        onChange={(e) =>
          startTransition(() => router.push(`/?sub=${e.target.value}`))
        }
      >
        {options.length === 0 && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.codigo} value={o.codigo}>
            {o.nome} ({o.codigo})
          </option>
        ))}
      </select>
      {pending && <span className="text-xs text-zinc-400">carregando…</span>}
    </label>
  );
}
