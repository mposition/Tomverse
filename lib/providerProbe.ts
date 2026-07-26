import "server-only";

import { generateText } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import {
  AVAILABLE_MODELS,
  getModelBillingProfile,
  type AiModel,
  type AiProvider,
} from "@/lib/models";
import {
  providerDiagnosticCode,
  safeErrorMetadata,
} from "@/lib/providerErrorClassification";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";

// AUD-R001: a synthetic, low-cost, non-billed provider probe. Deliberately
// mirrors the DI shape of lib/conversationTitle.ts's generateConversationTitle
// (an injectable `generate` so unit tests never touch the network) and never
// imports lib/chatSecurity.ts's credit reservation/settlement functions --
// probes are internal bookkeeping only, never a user-facing chat turn.

export type ProviderProbeFailureReason =
  | "no_probe_model"
  | "timeout"
  | "provider_error";

export type ProviderProbeOutcome =
  | {
      ok: true;
      provider: AiProvider;
      modelId: string;
      timedOut: false;
      latencyMs: number;
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      ok: false;
      provider: AiProvider;
      modelId: string | null;
      reason: ProviderProbeFailureReason;
      timedOut: boolean;
      diagnosticCode?: string;
      latencyMs: number;
    };

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_TOKENS = 8;

export const DEFAULT_PROBE_DAILY_COST_CAP_USD = 1;

/** Shared by the probe route (to decide whether to skip a cycle) and the
 *  provider health dashboard (to show operators today's spend against the
 *  same cap) -- kept in one place so the two can never disagree about what
 *  the configured cap actually is. */
export const probeDailyCostCapMicroUsd = (): number => {
  const raw = Number(process.env.PROVIDER_PROBE_DAILY_COST_CAP_USD);
  const capUsd = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROBE_DAILY_COST_CAP_USD;
  return Math.round(capUsd * 1_000_000);
};

const PROBE_PROMPT = "Reply with exactly one word: OK";
const PROBE_SYSTEM_PROMPT =
  "You are a synthetic health-check probe. Reply with exactly the single word OK and nothing else.";

let cachedModelOverrides: Record<string, string> | undefined;

/**
 * Parses PROVIDER_PROBE_MODEL_OVERRIDES (a JSON map of provider -> modelId),
 * matching the CONVERSATION_TITLE_MODEL_ID-style override convention already
 * used in this codebase. A malformed value is ignored (falls back to the
 * registry-driven default) rather than crashing the whole probe cycle.
 */
const parseModelOverrides = (): Record<string, string> => {
  if (cachedModelOverrides !== undefined) return cachedModelOverrides;
  const raw = process.env.PROVIDER_PROBE_MODEL_OVERRIDES?.trim();
  if (!raw) {
    cachedModelOverrides = {};
    return cachedModelOverrides;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      );
      cachedModelOverrides = Object.fromEntries(entries);
      return cachedModelOverrides;
    }
  } catch {
    // fall through
  }
  cachedModelOverrides = {};
  return cachedModelOverrides;
};

const totalPricePerMillionTokens = (model: AiModel) => {
  const billing = getModelBillingProfile(model);
  return billing.inputUsdPerMillionTokens + billing.outputUsdPerMillionTokens;
};

/**
 * Picks one representative model to probe per provider: the cheapest
 * enabled "standard" model where one exists, or -- for the two providers
 * with no standard-tier option at all (moonshot, perplexity) -- the
 * cheapest enabled model regardless of tier. A probe's cost profile is
 * unrelated to the user-facing billing tier, so tier is only a preference
 * here, never a hard filter. An explicit env override always wins.
 */
export const getProbeModelFor = (provider: AiProvider): AiModel | undefined => {
  const overrideId = parseModelOverrides()[provider];
  if (overrideId) {
    const overridden = AVAILABLE_MODELS.find(
      (model) =>
        model.id === overrideId && model.provider === provider && model.enabled
    );
    if (overridden) return overridden;
  }

  const enabledForProvider = AVAILABLE_MODELS.filter(
    (model) => model.provider === provider && model.enabled
  );
  if (enabledForProvider.length === 0) return undefined;

  const standardModels = enabledForProvider.filter(
    (model) => model.usageClass === "standard"
  );
  const candidates = standardModels.length > 0 ? standardModels : enabledForProvider;

  return candidates.reduce((cheapest, model) =>
    totalPricePerMillionTokens(model) < totalPricePerMillionTokens(cheapest)
      ? model
      : cheapest
  );
};

/**
 * development defaults to a safe no-op (so local dev never needs live keys
 * or spends real money just to exercise the scheduler wiring) unless
 * PROVIDER_PROBE_FORCE_LIVE=true is explicitly set for manual staging-style
 * testing. test always stays off regardless of that flag -- a stray env var
 * in CI must never cause a real network call. production is always live.
 */
const isLiveProbeEnvironment = (): boolean => {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.NODE_ENV === "production") return true;
  return process.env.PROVIDER_PROBE_FORCE_LIVE === "true";
};

export async function runProviderProbe(
  provider: AiProvider,
  deps?: { generate?: typeof generateText }
): Promise<ProviderProbeOutcome> {
  const startedAt = Date.now();
  const model = getProbeModelFor(provider);
  if (!model) {
    return {
      ok: false,
      provider,
      modelId: null,
      reason: "no_probe_model",
      timedOut: false,
      latencyMs: 0,
    };
  }

  const injectedGenerate = deps?.generate;
  if (!injectedGenerate && !isLiveProbeEnvironment()) {
    return {
      ok: true,
      provider,
      modelId: model.id,
      timedOut: false,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const generate = injectedGenerate ?? generateText;
  try {
    const result = await generate({
      model: getActiveAiModel(model),
      system: PROBE_SYSTEM_PROMPT,
      prompt: PROBE_PROMPT,
      temperature: 0,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      ok: true,
      provider,
      modelId: model.id,
      timedOut: false,
      latencyMs: Date.now() - startedAt,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      },
    };
  } catch (error) {
    const metadata = safeErrorMetadata(error);
    const timedOut = metadata.name === "AbortError" || metadata.name === "TimeoutError";
    return {
      ok: false,
      provider,
      modelId: model.id,
      reason: timedOut ? "timeout" : "provider_error",
      timedOut,
      diagnosticCode: providerDiagnosticCode("PROVIDER_PROBE_FAILED", error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Best-effort internal cost bookkeeping for one successful probe call, under
 * source "probe" (never "internal") so the daily probe cost cap can be
 * queried in isolation from other non-billed internal usage (e.g.
 * conversation titles). Callers must wrap this in their own try/catch --
 * a logging failure here must never fail the probe cycle itself.
 */
export async function recordProbeUsage(
  outcome: Extract<ProviderProbeOutcome, { ok: true }>
): Promise<void> {
  const model = AVAILABLE_MODELS.find((candidate) => candidate.id === outcome.modelId);
  if (!model) return;
  const billing = getModelBillingProfile(model);
  const cost = calculateProviderUsageCost({
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    inputUsdPerMillionTokens: billing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: billing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: billing.cachedInputPriceMultiplier,
  });
  await recordInternalProviderUsage({
    provider: outcome.provider,
    modelId: outcome.modelId,
    inputTokens: cost.inputTokens,
    cachedInputTokens: cost.cachedInputTokens,
    outputTokens: cost.outputTokens,
    estimatedCostMicroUsd: cost.totalCostMicroUsd,
    uncachedInputCostMicroUsd: cost.uncachedInputCostMicroUsd,
    cachedInputCostMicroUsd: cost.cachedInputCostMicroUsd,
    outputCostMicroUsd: cost.outputCostMicroUsd,
    source: "probe",
  });
}
