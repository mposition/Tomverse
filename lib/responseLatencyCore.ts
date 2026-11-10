import { z } from "zod";

const duration = z.number().int().min(0).max(3_600_000);
export const clientLatencyStagesSchema = z.object({
  submitHandoffMs: duration.optional(),
  attachmentPrepareMs: duration.optional(),
  conversationPrepareMs: duration.optional(),
  modelSyncMs: duration.optional(),
  preflightMs: duration.optional(),
  contextPrepareMs: duration.optional(),
  draftPrepareMs: duration.optional(),
  refinerPrepareMs: duration.optional(),
  messageSaveMs: duration.optional(),
  panelHandoffMs: duration.optional(),
  locationMs: duration.optional(),
  locationIntentMs: duration.optional(),
  responseHeadersMs: duration.optional(),
  dispatchToContentMs: duration.optional(),
  contentToEndMs: duration.optional(),
  clientFinalizeMs: duration.optional(),
}).strict();
export type ClientLatencyStages = z.infer<typeof clientLatencyStagesSchema>;
export const responseLatencyTimingsSchema = z.object({
  ...clientLatencyStagesSchema.shape,
  prepareMs: duration.optional(),
  firstContentMs: duration.optional(),
  completionMs: duration.optional(),
  settlementMs: duration.optional(),
  routingMs: duration.optional(),
  presearchMs: duration.optional(),
  contextMs: duration.optional(),
  preProviderMs: duration.optional(),
  beforeRoutingMs: duration.optional(),
  afterRoutingMs: duration.optional(),
  providerToContentMs: duration.optional(),
  firstReviewMs: duration.optional(),
  reviewMs: duration.optional(),
}).strict();
export type ResponseLatencyTimings = z.infer<typeof responseLatencyTimingsSchema>;
export const responseLatencyDimensionsSchema = z.object({
  product: z.enum(["chat", "review", "unknown"]),
  mode: z.enum(["auto", "manual", "cross_review", "unknown"]),
  modelId: z.string().max(120).nullable(),
  provider: z.string().max(40).nullable(),
}).strict();
export type ResponseLatencyDimensions = z.infer<typeof responseLatencyDimensionsSchema>;
export const responseLatencyOutcomeSchema = z.enum(["completed", "cancelled", "failed", "empty", "failed_before_stream", "primary_only", "cached"]);
export type ResponseLatencySample = ResponseLatencyDimensions & {
  source: "server" | "client" | "review";
  outcome: z.infer<typeof responseLatencyOutcomeSchema>;
  timings: ResponseLatencyTimings;
};
export const clientLatencyBodySchema = z.object({
  token: z.string().min(1).max(2_048),
  outcome: z.enum(["completed", "cancelled", "failed"]),
  prepareMs: duration,
  firstContentMs: duration.nullable(),
  completionMs: duration,
  stages: clientLatencyStagesSchema.optional(),
}).strict().refine(value => value.prepareMs <= value.completionMs &&
  (value.firstContentMs === null || (value.firstContentMs >= value.prepareMs && value.firstContentMs <= value.completionMs)) &&
  Object.values(value.stages ?? {}).every(ms => ms <= value.completionMs),
  "Timing events must follow submission order.");

export function latencyDistribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

/** Arithmetic only. The existing optimizer LLM interprets the evidence. */
export function summarizeResponseLatency(samples: ResponseLatencySample[]) {
  const groups = new Map<string, ResponseLatencySample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.product, sample.mode, sample.source, sample.modelId, sample.outcome]);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  return {
    sampleCount: samples.length,
    omittedGroups: Math.max(0, sorted.length - 24),
    groups: sorted.slice(0, 24).map(rows => ({
      product: rows[0].product, mode: rows[0].mode, source: rows[0].source,
      modelId: rows[0].modelId, outcome: rows[0].outcome, count: rows.length,
      evidence: rows.length < 30 ? "small_sample" : "observational",
      outcomes: Object.fromEntries([...new Set(rows.map(row => row.outcome))].map(outcome =>
        [outcome, rows.filter(row => row.outcome === outcome).length])),
      timings: Object.fromEntries(Object.keys(responseLatencyTimingsSchema.shape).map(key => [key,
        latencyDistribution(rows.flatMap(row => {
          const value = row.timings[key as keyof ResponseLatencyTimings];
          return value === undefined ? [] : [value];
        })),
      ])),
    })),
  };
}

export const RESPONSE_LATENCY_ANALYSIS_RULE =
  "responseLatency is content-free observational timing evidence, not a causal benchmark. " +
  "Compare only the same product, mode, source and outcome. Client timings are untrusted browser reports; " +
  "Client firstContentMs ends when text reaches UI state, not actual browser paint; completionMs ends when the client handler finishes. " +
  "Review firstReviewMs and reviewMs start at service entry and exclude route persistence. Sample count counts measurements, not unique requests. " +
  "server firstContentMs starts at API receipt and settlementMs is not completion. " +
  "Parallel timings overlap: never sum them or subtract unrelated percentiles. Missing measurements are unknown. " +
  "contextPrepareMs and draftPrepareMs run together. locationIntentMs may overlap refinerPrepareMs during parallel preparation; otherwise it is nested within locationMs. locationMs includes remaining device and human permission waits. " +
  "Report sample counts; small samples cannot prove a model is faster. Keep failed/cancelled/primary-only outcomes visible. " +
  "Recommend concrete code or setting experiments that reduce waiting while preserving selected models, both reviewers, " +
  "grounding, tools, memory, authorization, credits and quality. Distinguish earlier display from faster final completion. " +
  "Do not change live settings or claim measured savings from these observations alone. Use the existing report recommendations.";

export type ResponseLatencyEvidence =
  | { status: "unavailable"; windowDays: number }
  | ({ status: "available"; windowDays: number; truncated: boolean } & ReturnType<typeof summarizeResponseLatency>);
