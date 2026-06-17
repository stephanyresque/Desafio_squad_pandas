// Teste de paridade Python ↔ TS.
// Lê pipeline/data/parity_cases.json (features + yhat de referência, com o histórico embutido),
// recomputa as features e o yhat pela MESMA lógica TS usada na rota /api/forecast, e afirma
// que cada feature e cada yhat batem com o Python. Tolerância apertada (rel < 1e-6 OU abs < 0.01).
// Se qualquer caso divergir, o processo falha (exit 1) apontando feature/caso.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeFeatureMap,
  orderFeatures,
} from "../lib/forecast/features";
import { predictRidge } from "../lib/forecast/infer";
import type { ServedArtifact } from "../lib/forecast/types";

type ParityCase = {
  label: string;
  target_ts: string;
  features: number[];
  yhat: number;
  history: Record<string, number>;
};
type ParityFile = { artifact: ServedArtifact; cases: ParityCase[] };

const here = dirname(fileURLToPath(import.meta.url));
const parity = JSON.parse(
  readFileSync(resolve(here, "../../pipeline/data/parity_cases.json"), "utf8"),
) as ParityFile;
// MESMA lista de feriados que a rota usa (cópia em web/lib/forecast).
const holidays = JSON.parse(
  readFileSync(resolve(here, "../lib/forecast/holidays_br.json"), "utf8"),
) as string[];
const holidaySet = new Set(holidays);
const artifact = parity.artifact;

const REL_TOL = 1e-6;
const ABS_TOL = 0.01;

function isClose(a: number, b: number): boolean {
  const d = Math.abs(a - b);
  return d < ABS_TOL || d / Math.max(Math.abs(b), 1e-12) < REL_TOL;
}

let fails = 0;
let maxAbsFeat = 0;
let maxRelFeat = 0;
let maxAbsY = 0;
let maxRelY = 0;

for (const c of parity.cases) {
  const byEpoch = new Map<number, number>();
  for (const [iso, v] of Object.entries(c.history)) {
    byEpoch.set(Date.parse(iso), v);
  }
  const targetEpoch = Date.parse(c.target_ts);

  const fr = computeFeatureMap(targetEpoch, (e) => byEpoch.get(e), holidaySet);
  if (!fr.ok) {
    console.error(`[FAIL] ${c.label}: histórico insuficiente (offsets ${fr.missingOffsetsH}).`);
    fails++;
    continue;
  }
  const x = orderFeatures(fr.features, artifact.features);

  for (let i = 0; i < artifact.features.length; i++) {
    const d = Math.abs(x[i] - c.features[i]);
    maxAbsFeat = Math.max(maxAbsFeat, d);
    maxRelFeat = Math.max(maxRelFeat, d / Math.max(Math.abs(c.features[i]), 1e-12));
    if (!isClose(x[i], c.features[i])) {
      console.error(
        `[FAIL] ${c.label} · feature '${artifact.features[i]}': TS=${x[i]} Py=${c.features[i]} (Δ=${d})`,
      );
      fails++;
    }
  }

  const yTs = predictRidge(x, artifact);
  const dY = Math.abs(yTs - c.yhat);
  maxAbsY = Math.max(maxAbsY, dY);
  maxRelY = Math.max(maxRelY, dY / Math.max(Math.abs(c.yhat), 1e-12));
  if (!isClose(yTs, c.yhat)) {
    console.error(`[FAIL] ${c.label} · yhat: TS=${yTs} Py=${c.yhat} (Δ=${dY})`);
    fails++;
  }
}

console.log(`casos avaliados: ${parity.cases.length} (${artifact.features.length} features cada)`);
console.log(
  `maior Δ feature: abs=${maxAbsFeat.toExponential(3)} | rel=${maxRelFeat.toExponential(3)}`,
);
console.log(`maior Δ yhat:    abs=${maxAbsY.toExponential(3)} | rel=${maxRelY.toExponential(3)}`);

if (fails > 0) {
  console.error(`\nPARIDADE FALHOU: ${fails} divergência(s) acima da tolerância.`);
  process.exit(1);
}
console.log("\nPARIDADE OK: o TS reproduz o Python em todas as features e previsões.");
