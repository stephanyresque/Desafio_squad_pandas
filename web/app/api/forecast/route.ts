import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase";
import holidaysBr from "@/lib/forecast/holidays_br.json";
import {
  brEpoch,
  brHourKey,
  computeFeatureMap,
  HOUR_MS,
  orderFeatures,
} from "@/lib/forecast/features";
import { predictRidge } from "@/lib/forecast/infer";
import type { ForecastPoint, ServedArtifact } from "@/lib/forecast/types";

export const dynamic = "force-dynamic";

const SERVED_MODEL = "ridge_v1_served";
const HOLIDAYS = new Set<string>(holidaysBr as string[]);

// histórico necessário: das 24 horas-alvo, a primeira (00:00) precisa de até t−191h,
// e a última (23:00) precisa de até t−24h = primeira − 1h.
const HISTORY_BACK_H = 192;

function parseTargetDate(dateParam: string | null): {
  year: number;
  month: number;
  day: number;
} | null {
  const raw = dateParam ?? brHourKey(Date.now() + 24 * HOUR_MS).slice(0, 10); // amanhã (Brasília)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const subsystem = (url.searchParams.get("subsystem") ?? "SECO").toUpperCase();
  const target = parseTargetDate(url.searchParams.get("date"));
  if (!target) {
    return NextResponse.json(
      { error: "Parâmetro 'date' inválido. Use YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const supabase = createClient();

  // 1) Artifact do Ridge servido
  const artifactResult = await supabase
    .from("model_runs")
    .select("id, artifact")
    .eq("model_name", SERVED_MODEL)
    .order("trained_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (artifactResult.error) {
    return NextResponse.json(
      { error: `Erro ao ler o modelo servido: ${artifactResult.error.message}` },
      { status: 500 },
    );
  }
  const artifact = artifactResult.data?.artifact as ServedArtifact | undefined;
  if (!artifact) {
    return NextResponse.json(
      { error: `Modelo servido '${SERVED_MODEL}' não encontrado.` },
      { status: 404 },
    );
  }
  const modelRunId = artifactResult.data?.id as number;

  // 2) Janela de horas-alvo (24h do dia D+1) e janela de histórico necessária
  const firstTargetEpoch = brEpoch(target.year, target.month, target.day, 0);
  const targetEpochs = Array.from(
    { length: 24 },
    (_, h) => firstTargetEpoch + h * HOUR_MS,
  );

  const loEpoch = firstTargetEpoch - HISTORY_BACK_H * HOUR_MS;
  const hiEpoch = firstTargetEpoch - HOUR_MS;

  const actualResult = await supabase
    .from("load_actual")
    .select("ts, load_mw, subsystems!inner(codigo)")
    .eq("subsystems.codigo", subsystem)
    .gte("ts", new Date(loEpoch).toISOString())
    .lte("ts", new Date(hiEpoch).toISOString())
    .order("ts", { ascending: true });

  if (actualResult.error) {
    return NextResponse.json(
      { error: `Erro ao ler a carga verificada: ${actualResult.error.message}` },
      { status: 500 },
    );
  }

  const byEpoch = new Map<number, number>();
  for (const row of (actualResult.data ?? []) as {
    ts: string;
    load_mw: number | string;
  }[]) {
    byEpoch.set(Date.parse(row.ts), Number(row.load_mw));
  }
  const getActual = (epochMs: number) => byEpoch.get(epochMs);

  // 3) Features + inferência por hora-alvo (piso de 24h)
  const predictions: ForecastPoint[] = [];
  const missing: { target_ts: string; missing_offsets_h: number[] }[] = [];

  for (const epoch of targetEpochs) {
    const fr = computeFeatureMap(epoch, getActual, HOLIDAYS);
    if (!fr.ok) {
      missing.push({
        target_ts: brHourKey(epoch),
        missing_offsets_h: fr.missingOffsetsH,
      });
      continue;
    }
    const x = orderFeatures(fr.features, artifact.features);
    const yhat = predictRidge(x, artifact);
    predictions.push({
      target_ts: brHourKey(epoch),
      predicted_mw: Number(yhat.toFixed(2)),
    });
  }

  // Histórico insuficiente para alguma hora → erro claro, sem inventar valor
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "Histórico de carga verificada insuficiente para esta data.",
        subsystem,
        target_date: `${target.year}-${String(target.month).padStart(2, "0")}-${String(
          target.day,
        ).padStart(2, "0")}`,
        missing_hours: missing,
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    subsystem,
    target_date: `${target.year}-${String(target.month).padStart(2, "0")}-${String(
      target.day,
    ).padStart(2, "0")}`,
    model_name: SERVED_MODEL,
    model_run_id: modelRunId,
    horizon_h: artifact.horizon_h,
    leakage_floor_h: artifact.leakage_floor_h,
    predictions,
  });
}
