"use client";

import { useEffect, useId, useRef, useState } from "react";

export type MetricTriple = {
  mape: number;
  mae: number;
  rmse: number;
};

type MetricKey = "mape" | "mae" | "rmse";

type MetricCard = {
  key: MetricKey;
  title: string;
  value: string;
  ref: string | null;
};

type MetricExplain = {
  title: string;
  oneLine: string;
  howToRead: string;
  whyMatters: string;
};

const EXPLAIN: Record<MetricKey, MetricExplain> = {
  mape: {
    title: "MAPE: Erro Percentual Absoluto Médio",
    oneLine: "o quanto a previsão erra, em média, em porcentagem.",
    howToRead:
      "para cada hora, calcula-se |real − previsto| ÷ real; o MAPE é a média desses percentuais. Um MAPE de 1,1% significa que, em média, a previsão errou 1,1% da carga real. Quanto menor, melhor.",
    whyMatters:
      "por ser percentual, permite comparar regiões de tamanhos muito diferentes na mesma escala. É a métrica principal deste projeto.",
  },
  mae: {
    title: "MAE: Erro Absoluto Médio",
    oneLine: "o tamanho médio do erro, na própria unidade de carga (MWmed).",
    howToRead:
      "para cada hora, calcula-se |real − previsto|; o MAE é a média. Um MAE de 459 MWmed significa que, em média, a previsão errou cerca de 459 MWmed (para mais ou para menos). Quanto menor, melhor.",
    whyMatters:
      "está na unidade real do sistema, então é tangível. É uma métrica robusta: uma única hora muito ruim não distorce o resultado de forma desproporcional.",
  },
  rmse: {
    title: "RMSE: Raiz do Erro Quadrático Médio",
    oneLine: "parecido com o MAE, mas pune erros grandes com mais força.",
    howToRead:
      "também em MWmed, mas cada erro é elevado ao quadrado antes de tirar a média (e depois extrai-se a raiz). Por isso o RMSE é sempre maior ou igual ao MAE. Quando o RMSE é bem maior que o MAE, é sinal de que existem algumas horas com erros grandes puxando o resultado.",
    whyMatters:
      "erros grandes são os mais perigosos na operação real da rede (podem significar apagão ou desperdício). O RMSE dá peso a eles.",
  },
};

const FOOTER =
  "Calculado sobre o teste retroativo de 12 meses: o modelo prevendo a carga do dia seguinte, comparado à carga verificada, nas mesmas horas que o ONS.";

// Fórmula de cada métrica (y = real, ŷ = previsto, n = nº de horas).
const FORMULA: Record<MetricKey, string> = {
  mape: "= (100 / n) · Σ |y − ŷ| / y",
  mae: "= (1 / n) · Σ |y − ŷ|",
  rmse: "= √[ (1 / n) · Σ (y − ŷ)² ]",
};

function fmtPct(value: number): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function fmtMw(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

// Cards lêem do MESMO backtest da tabela "Comparação de modelos" (evaluations):
// valor = LightGBM; subtexto = a Programada ONS na mesma métrica/período.
function buildCards(model: MetricTriple, ons: MetricTriple | null): MetricCard[] {
  return [
    {
      key: "mape",
      title: "MAPE do modelo",
      value: fmtPct(model.mape),
      ref: ons ? `vs ONS: ${fmtPct(ons.mape)}` : null,
    },
    {
      key: "mae",
      title: "MAE do modelo",
      value: `${fmtMw(model.mae)} MWmed`,
      ref: ons ? `vs ONS: ${fmtMw(ons.mae)}` : null,
    },
    {
      key: "rmse",
      title: "RMSE do modelo",
      value: `${fmtMw(model.rmse)} MWmed`,
      ref: ons ? `vs ONS: ${fmtMw(ons.rmse)}` : null,
    },
  ];
}

function MetricModal({
  metric,
  onClose,
}: {
  metric: MetricKey;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const content = EXPLAIN[metric];

  // Fecha no Esc; foca o botão de fechar ao abrir.
  useEffect(() => {
    closeRef.current?.focus();
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
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-sm shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute right-3 top-3 rounded p-1 text-xl leading-none text-zinc-400 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:text-zinc-200"
        >
          ×
        </button>

        <h2
          id={titleId}
          className="pr-6 text-base font-semibold text-zinc-900 dark:text-zinc-50"
        >
          {content.title}
        </h2>

        <div className="mt-3 space-y-2 text-zinc-700 dark:text-zinc-300">
          <p>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              Em uma frase:
            </span>{" "}
            {content.oneLine}
          </p>
          <p>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              Como ler:
            </span>{" "}
            {content.howToRead}
          </p>
          <p>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              Por que importa:
            </span>{" "}
            {content.whyMatters}
          </p>
        </div>

        <div className="mt-4">
          <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Fórmula
          </p>
          <div className="rounded-md bg-zinc-100 px-3 py-2.5 text-center font-mono text-[15px] text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-100">
            <span className="font-semibold">{metric.toUpperCase()}</span>{" "}
            {FORMULA[metric]}
          </div>
          <p className="mt-1.5 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
            y = carga real · ŷ = previsão · n = nº de horas
          </p>
        </div>

        <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          {FOOTER}
        </p>
      </div>
    </div>
  );
}

export default function KpiCards({
  metrics,
  ons,
}: {
  metrics: MetricTriple;
  ons: MetricTriple | null;
}) {
  const [open, setOpen] = useState<MetricKey | null>(null);
  const cards = buildCards(metrics, ons);

  return (
    <>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => setOpen(card.key)}
            aria-haspopup="dialog"
            className="cursor-pointer rounded-lg border border-zinc-200 p-4 text-left transition-colors hover:border-[#AC4DFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#AC4DFF] dark:border-zinc-800 dark:hover:border-[#AC4DFF]"
          >
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              {card.title}
            </p>
            <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              {card.value}
            </p>
            {card.ref && (
              <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                {card.ref}
              </p>
            )}
          </button>
        ))}
      </div>

      {open && <MetricModal metric={open} onClose={() => setOpen(null)} />}
    </>
  );
}
