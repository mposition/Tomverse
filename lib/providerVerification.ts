import "server-only";

import { generateText } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import {
  AVAILABLE_MODELS,
  getModelBillingProfile,
  type AiModel,
  type AiProvider,
} from "@/lib/models";
import { PROVIDER_API_CONFIGURATION } from "@/lib/modelRegistryShared";
import {
  classifyProbeError,
  providerDiagnosticCode,
  redactProviderText,
  safeErrorMessage,
  safeErrorMetadata,
  type ProbeErrorClassification,
} from "@/lib/providerErrorClassification";
import type { ProviderVerificationStatus } from "@/lib/providerRecoveryCore";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";

// STG-R002: the live provider verification call behind the admin console's
// "Run verification" action.
//
// Deliberately separate from lib/providerProbe.ts rather than an option on it:
//
//   * the scheduled probe must stay off Perplexity entirely (every Perplexity
//     model is search-backed, so probing one bills a web search each cycle --
//     see PROBE_EXCLUDED_USAGE_CLASSES). Verification is the opposite case: it
//     is explicitly operator-triggered, one call at a time, behind a cooldown
//     and a confirmation, so paying for one search to establish ground truth
//     is the point.
//   * the two write to different evidence fields and must never be conflated.
//
// What this module never does: create a Conversation, a Message or a
// CreditLedger entry, reserve or settle user credits, or persist an API key,
// an Authorization header, a raw provider response body or any prompt content.

/** Marks every request this module sends, so a verification call is
 *  identifiable in code review, in provider dashboards and in usage rows. */
export const VERIFICATION_REQUEST_MARKER = "tomverse-admin-provider-verification";

const VERIFICATION_TIMEOUT_MS = 20_000;

// The provider only has to answer at all. Kept above the observed provider
// floors (OpenAI rejects a max_output_tokens below 16) with a little headroom
// for models that emit reasoning tokens, and no higher -- output tokens are
// the expensive half of every price sheet here.
const VERIFICATION_MAX_OUTPUT_TOKENS = 16;

const VERIFICATION_SYSTEM_PROMPT =
  "You are an administrator-triggered availability check. Reply with exactly the single word OK and nothing else.";
const VERIFICATION_PROMPT = "Reply with exactly one word: OK";

/**
 * Usage classes a verification call must never use. Deep research is a
 * long-running, expensive async job on a completely different HTTP contract --
 * and on Perplexity it is precisely the model whose request-contract failures
 * caused the incident this feature exists to recover from. Verifying with it
 * would re-run the failing request instead of establishing whether the
 * provider itself is reachable.
 */
const VERIFICATION_EXCLUDED_USAGE_CLASSES = new Set(["deep-research"]);

/**
 * Explicit per-provider verification model. Price alone does not pick these:
 * Perplexity's three non-deep-research models share one default price, so
 * "cheapest" would resolve by declaration order. Naming sonar outright makes
 * the choice reviewable -- it is Perplexity's cheapest and simplest search
 * tier, and the one a recovery should be judged against.
 */
export const PROVIDER_VERIFICATION_PREFERRED_MODEL_IDS: Partial<
  Record<AiProvider, string>
> = {
  perplexity: "perplexity/sonar",
};

let cachedVerificationOverrides: Record<string, string> | undefined;

/**
 * Parses PROVIDER_VERIFICATION_MODEL_OVERRIDES (a JSON map of provider ->
 * modelId), matching the PROVIDER_PROBE_MODEL_OVERRIDES convention. A
 * malformed value is ignored rather than failing the verification.
 */
const parseVerificationOverrides = (): Record<string, string> => {
  if (cachedVerificationOverrides !== undefined) return cachedVerificationOverrides;
  const raw = process.env.PROVIDER_VERIFICATION_MODEL_OVERRIDES?.trim();
  if (!raw) {
    cachedVerificationOverrides = {};
    return cachedVerificationOverrides;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cachedVerificationOverrides = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
      return cachedVerificationOverrides;
    }
  } catch {
    // fall through to the registry-driven default
  }
  cachedVerificationOverrides = {};
  return cachedVerificationOverrides;
};

const totalPricePerMillionTokens = (model: AiModel) => {
  const billing = getModelBillingProfile(model);
  return billing.inputUsdPerMillionTokens + billing.outputUsdPerMillionTokens;
};

const isVerifiable = (model: AiModel, provider: AiProvider) =>
  model.provider === provider &&
  model.enabled &&
  !VERIFICATION_EXCLUDED_USAGE_CLASSES.has(model.usageClass);

/**
 * Picks the model one verification call should use: an explicit environment
 * override, then the documented per-provider preference, then the cheapest
 * enabled "standard" model, then the cheapest verifiable model of any tier.
 *
 * Unlike getProbeModelFor this never returns undefined for a search-backed
 * provider -- refusing to verify Perplexity is what left it with no way out of
 * a self-locking incident.
 */
export const getVerificationModelFor = (
  provider: AiProvider
): AiModel | undefined => {
  const overrideId = parseVerificationOverrides()[provider];
  if (overrideId) {
    const overridden = AVAILABLE_MODELS.find(
      (model) => model.id === overrideId && isVerifiable(model, provider)
    );
    if (overridden) return overridden;
  }

  const preferredId = PROVIDER_VERIFICATION_PREFERRED_MODEL_IDS[provider];
  if (preferredId) {
    const preferred = AVAILABLE_MODELS.find(
      (model) => model.id === preferredId && isVerifiable(model, provider)
    );
    if (preferred) return preferred;
  }

  const verifiable = AVAILABLE_MODELS.filter((model) =>
    isVerifiable(model, provider)
  );
  if (verifiable.length === 0) return undefined;

  const standardModels = verifiable.filter(
    (model) => model.usageClass === "standard"
  );
  const candidates = standardModels.length > 0 ? standardModels : verifiable;
  return candidates.reduce((cheapest, model) =>
    totalPricePerMillionTokens(model) < totalPricePerMillionTokens(cheapest)
      ? model
      : cheapest
  );
};

export const isVerificationApiKeyConfigured = (provider: AiProvider) => {
  const envName = PROVIDER_API_CONFIGURATION[provider].apiKeyEnvName;
  return typeof process.env[envName] === "string" &&
    process.env[envName]!.trim().length > 0;
};

/**
 * Whether a verification call bills the provider. Every live verification
 * does; the flag exists so the admin UI can state it before the operator
 * commits, rather than discovering it on the invoice.
 */
export const verificationIncursProviderCost = (provider: AiProvider) =>
  Boolean(getVerificationModelFor(provider));

export type ProviderVerificationResult = {
  provider: AiProvider;
  status: ProviderVerificationStatus;
  modelId: string | null;
  latencyMs: number | null;
  /** Sanitized, in the shape providerDiagnosticCode() produces. */
  diagnosticCode: string | null;
  /** Coarse public-safe label; never a raw provider message. */
  errorClassification: ProbeErrorClassification | null;
  /** Redacted and truncated. Never contains a key or an Authorization header. */
  message: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

/**
 * Mirrors lib/providerProbe.ts's isLiveProbeEnvironment, and deliberately
 * fails closed: anything that is not explicitly production, or explicitly
 * opted in, performs no live call.
 *
 * The default matters more here than it looks. `NODE_ENV !== "test"` would
 * have been wrong -- the unit runner leaves NODE_ENV unset, so a test suite
 * would have reached the network and spent provider money. Requiring an
 * affirmative signal removes that whole class of accident. Staging and
 * production both run with NODE_ENV=production, which is where operators
 * actually use this; local development opts in with
 * PROVIDER_VERIFICATION_FORCE_LIVE=true.
 */
const isLiveVerificationEnvironment = () => {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.NODE_ENV === "production") return true;
  return process.env.PROVIDER_VERIFICATION_FORCE_LIVE === "true";
};

/**
 * Sends one minimal request to the provider and reports a sanitized outcome.
 * `deps.generate` is injectable so tests never touch the network.
 */
export async function runProviderVerification(
  provider: AiProvider,
  deps?: { generate?: typeof generateText }
): Promise<ProviderVerificationResult> {
  const model = getVerificationModelFor(provider);
  if (!model) {
    return {
      provider,
      status: "unavailable",
      modelId: null,
      latencyMs: null,
      diagnosticCode: "PROVIDER_VERIFICATION_UNAVAILABLE.NO_MODEL",
      errorClassification: null,
      message:
        "No enabled model is available to verify this provider with.",
      usage: null,
    };
  }
  if (!isVerificationApiKeyConfigured(provider)) {
    return {
      provider,
      status: "unavailable",
      modelId: model.id,
      latencyMs: null,
      diagnosticCode: "PROVIDER_VERIFICATION_UNAVAILABLE.NO_API_KEY",
      errorClassification: null,
      message: `No API key is configured for ${provider}, so no live call can be made.`,
      usage: null,
    };
  }

  const injectedGenerate = deps?.generate;
  if (!injectedGenerate && !isLiveVerificationEnvironment()) {
    return {
      provider,
      status: "unavailable",
      modelId: model.id,
      latencyMs: null,
      diagnosticCode: "PROVIDER_VERIFICATION_UNAVAILABLE.LIVE_CALLS_DISABLED",
      errorClassification: null,
      message: "Live provider verification is disabled in this environment.",
      usage: null,
    };
  }

  const generate = injectedGenerate ?? generateText;
  const startedAt = Date.now();
  try {
    const result = await generate({
      model: getActiveAiModel(model),
      ...getModelGenerationSettings(model),
      system: VERIFICATION_SYSTEM_PROMPT,
      prompt: VERIFICATION_PROMPT,
      // Keep the request shape minimal: no temperature or tools. The shared
      // compatibility helper only adds provider options required for a model
      // whose catalog identity promises a reasoning mode.
      maxOutputTokens: VERIFICATION_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
    });
    return {
      provider,
      status: "success",
      modelId: model.id,
      latencyMs: Date.now() - startedAt,
      diagnosticCode: null,
      errorClassification: null,
      message: null,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      },
    };
  } catch (error) {
    const metadata = safeErrorMetadata(error);
    const timedOut =
      metadata.name === "AbortError" || metadata.name === "TimeoutError";
    const diagnosticCode = providerDiagnosticCode(
      "PROVIDER_VERIFICATION_FAILED",
      error
    );
    return {
      provider,
      status: "failed",
      modelId: model.id,
      latencyMs: Date.now() - startedAt,
      diagnosticCode,
      errorClassification: classifyProbeError(diagnosticCode, timedOut),
      message: redactProviderText(safeErrorMessage(error), 300),
      usage: null,
    };
  }
}

/**
 * Best-effort internal cost bookkeeping for one successful verification, under
 * source "admin_verification" so operator-triggered spend stays separable from
 * both user traffic and the probe budget. Never a credit ledger entry and
 * never attributed to a user. Callers must wrap this in their own try/catch:
 * a bookkeeping failure must not change the verification's verdict.
 */
export async function recordVerificationUsage(
  result: ProviderVerificationResult
): Promise<void> {
  if (result.status !== "success" || !result.modelId || !result.usage) return;
  const model = AVAILABLE_MODELS.find(
    (candidate) => candidate.id === result.modelId
  );
  if (!model) return;
  const billing = getModelBillingProfile(model);
  const cost = calculateProviderUsageCost({
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    inputUsdPerMillionTokens: billing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: billing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: billing.cachedInputPriceMultiplier,
  });
  await recordInternalProviderUsage({
    provider: result.provider,
    modelId: result.modelId,
    inputTokens: cost.inputTokens,
    cachedInputTokens: cost.cachedInputTokens,
    outputTokens: cost.outputTokens,
    estimatedCostMicroUsd: cost.totalCostMicroUsd,
    uncachedInputCostMicroUsd: cost.uncachedInputCostMicroUsd,
    cachedInputCostMicroUsd: cost.cachedInputCostMicroUsd,
    outputCostMicroUsd: cost.outputCostMicroUsd,
    source: "admin_verification",
  });
}
