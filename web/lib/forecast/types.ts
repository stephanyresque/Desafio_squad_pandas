// Artifact serializado pelo Ridge servido (pipeline/model.py → model_runs.artifact).
// Tudo que a inferência em TS precisa para reproduzir
//   yhat = intercept + Σ coef_i · ((x_i − scaler_mean_i) / scaler_scale_i)
export type ServedArtifact = {
  model: string;
  alpha: number;
  subsystem: string;
  target: string;
  horizon_h: number;
  leakage_floor_h: number;
  features: string[]; // ORDEM exata das 20 features
  scaler_mean: number[];
  scaler_scale: number[];
  coef: number[];
  intercept: number;
  formula: string;
  trained_rows: number;
  train_start: string;
  train_end: string;
};

export type ForecastPoint = {
  target_ts: string; // hora-rótulo em Brasília (…-03:00)
  predicted_mw: number;
};
