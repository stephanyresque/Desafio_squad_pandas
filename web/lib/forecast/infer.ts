import type { ServedArtifact } from "./types";

// Inferência do Ridge servido — reproduz exatamente o sklearn Pipeline(StandardScaler, Ridge):
//   yhat = intercept + Σ coef_i · ((x_i − scaler_mean_i) / scaler_scale_i)
// `features` deve estar na ordem de `artifact.features`.
export function predictRidge(features: number[], artifact: ServedArtifact): number {
  let y = artifact.intercept;
  for (let i = 0; i < features.length; i++) {
    const z = (features[i] - artifact.scaler_mean[i]) / artifact.scaler_scale[i];
    y += artifact.coef[i] * z;
  }
  return y;
}
