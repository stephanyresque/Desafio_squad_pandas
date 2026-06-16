"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export type SubsystemOption = { codigo: string; nome: string };

// Seletor de subsistema via MODAL. Navega via ?sub=CODE — o server re-renderiza
// painel, KPIs e gráfico. As opções vêm de quem TEM linhas em evaluations, então a
// lista cresce sozinha quando novos subsistemas forem ingeridos (sem mexer em código).
export default function SubsystemSelector({
  options,
  value,
}: {
  options: SubsystemOption[];
  value: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const current = options.find((o) => o.codigo === value);
  const currentLabel = current ? `${current.nome} (${current.codigo})` : value;

  function choose(codigo: string) {
    setOpen(false);
    if (codigo !== value) {
      startTransition(() => router.push(`/?sub=${codigo}`));
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        Subsistema:
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending || options.length === 0}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-800 transition-colors hover:border-[#AC4DFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {currentLabel}
        <svg viewBox="0 0 20 20" className="h-4 w-4 text-zinc-400" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {pending && <span className="text-xs text-zinc-400">carregando…</span>}

      {open && (
        <SubsystemModal
          options={options}
          value={value}
          onChoose={choose}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SubsystemModal({
  options,
  value,
  onChoose,
  onClose,
}: {
  options: SubsystemOption[];
  value: string;
  onChoose: (codigo: string) => void;
  onClose: () => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Escolha o subsistema"
        className="relative w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute right-3 top-3 rounded p-1 text-xl leading-none text-zinc-400 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] dark:hover:text-zinc-200"
        >
          ×
        </button>

        <h2 className="pr-6 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Escolha o subsistema
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {options.map((o, i) => {
            const active = o.codigo === value;
            return (
              <button
                key={o.codigo}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                onClick={() => onChoose(o.codigo)}
                aria-pressed={active}
                className={
                  active
                    ? "rounded-md border border-[#AC4DFF] bg-[#AC4DFF]/10 px-3 py-2 text-left text-sm font-semibold text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] dark:text-zinc-50"
                    : "rounded-md border border-zinc-200 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:border-[#AC4DFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] dark:border-zinc-800 dark:text-zinc-300"
                }
              >
                <span className="block font-medium">{o.nome}</span>
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  {o.codigo}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
