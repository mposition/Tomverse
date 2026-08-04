import type { AiProvider } from "@/lib/models";

export type PublicModelStatus = "available" | "limited" | "unavailable";

export type ProviderFallback = {
  reason: string;
  recommendedModelIds: string[];
};

/**
 * What to offer when a whole provider is failing. Every id here must name a
 * model that is publicly selectable *and* belongs to a different provider --
 * a fallback pointing back at the provider that just went down is not a
 * fallback. Both invariants are pinned in tests/providerFallbackCandidates.
 *
 * Lives here rather than in lib/providerMonitoring so the table is a plain,
 * importable value: providerMonitoring is `server-only` and pulls in Prisma,
 * which put this policy out of reach of unit tests and let retired model ids
 * (llama-3-1) sit in it unnoticed.
 */
export const PROVIDER_FALLBACKS: Record<AiProvider, ProviderFallback> = {
  openai: { reason: "General model fallback", recommendedModelIds: ["gemini-2-5-flash", "claude-haiku-4-5", "mistral-small-4"] },
  anthropic: { reason: "Writing and analysis fallback", recommendedModelIds: ["gpt-5-6-luna", "gemini-2-5-flash", "mistral-small-4"] },
  google: { reason: "Fast general fallback", recommendedModelIds: ["gpt-5-6-luna", "mistral-small-4", "qwen3.6-flash"] },
  // Groq has no publicly listed model left -- Llama was retired along with
  // Groq's public hosting of it -- so this entry exists only for a future
  // Groq model. Its candidates are from other providers by construction.
  groq: { reason: "Fast open-model fallback", recommendedModelIds: ["mistral-small-4", "qwen3.6-flash", "deepseek-v4-flash"] },
  xai: { reason: "Current-answer fallback", recommendedModelIds: ["gpt-5-6-luna", "perplexity/sonar", "gemini-2-5-flash"] },
  deepseek: { reason: "Reasoning fallback", recommendedModelIds: ["qwen3.6-flash", "mistral-small-4", "gpt-5-6-luna"] },
  mistral: { reason: "EU/multilingual fallback", recommendedModelIds: ["qwen3.6-flash", "gpt-5-6-luna", "glm-5.2"] },
  moonshot: { reason: "Long-context reasoning fallback", recommendedModelIds: ["minimax-m3", "qwen3.7-plus", "deepseek-v4-pro"] },
  minimax: { reason: "Agentic reasoning fallback", recommendedModelIds: ["kimi-k3", "gemini-3-6-flash", "qwen3.7-plus"] },
  qwen: { reason: "Multilingual fallback", recommendedModelIds: ["mistral-small-4", "gemini-2-5-flash", "glm-5.2"] },
  zhipu: { reason: "GLM fallback", recommendedModelIds: ["qwen3.6-flash", "deepseek-v4-flash", "mistral-small-4"] },
  perplexity: { reason: "Search provider fallback; web-aware answer may be unavailable", recommendedModelIds: ["gpt-5-6-luna", "gemini-2-5-flash", "claude-haiku-4-5"] },
};

/**
 * How healthy the replacements offered for an unavailable model are, judged
 * from the same status snapshot the rest of the response is built from.
 *
 * - `operational` -- at least one candidate is fully available.
 * - `degraded`    -- candidates exist, but every one of them is limited.
 * - `none`        -- nothing usable is left to offer.
 * - `unknown`     -- provider health could not be read, so the candidate is
 *                    offered without any claim about it.
 */
export type FallbackHealth = "operational" | "degraded" | "none" | "unknown";

const CANDIDATE_RANK: Record<PublicModelStatus, number> = {
  available: 0,
  limited: 1,
  unavailable: 2,
};

/**
 * RECON-OPS-001. The public model-status route used to build its replacement
 * list from the registry's static `replacementModelId` plus the provider's
 * configured recommendations, with no reference to how those candidates were
 * doing at that moment. An incident banner could therefore -- and did --
 * recommend two models whose own providers were degraded in the very same
 * snapshot, and say nothing about it.
 *
 * This decides only *which* candidates are surfaced and *in what order*. It
 * never decides a status (that stays with the caller's status pass), and it
 * never swaps a model in on the user's behalf: when nothing healthy is left
 * it returns an empty list and `none`, so the UI can say so honestly instead
 * of printing a list that reads like a safe alternative.
 */
export function selectFallbackCandidates({
  replacementModelId,
  recommendedModelIds,
  isPublicModel,
  statusOf,
  canSelectModel,
}: {
  replacementModelId?: string | null;
  recommendedModelIds?: readonly string[];
  isPublicModel: (modelId: string) => boolean;
  statusOf: (modelId: string) => PublicModelStatus | undefined;
  /**
   * Whether the *current viewer* could actually select this candidate --
   * plan entitlement, guest limits, anything caller-specific. Omitted by
   * callers with no viewer (the public, cached status route), which is why
   * it defaults to allowing everything rather than to denying.
   *
   * Retiring the older Grok models onto the Pro-only grok-4-5 made this
   * load-bearing: without it a Free user's banner would offer a one-click
   * switch to a model the switch handler then refuses, and the honest
   * "pick another model" path would never be reached.
   */
  canSelectModel?: (modelId: string) => boolean;
}): { fallbackModelIds: string[]; fallbackHealth: FallbackHealth } {
  const fallbackModelIds = Array.from(
    new Set([
      ...(replacementModelId ? [replacementModelId] : []),
      ...(recommendedModelIds ?? []),
    ])
  )
    // A candidate that is itself unavailable is not a replacement, and
    // neither is one this viewer is not entitled to run.
    .filter(
      (modelId) =>
        isPublicModel(modelId) &&
        statusOf(modelId) !== "unavailable" &&
        (canSelectModel?.(modelId) ?? true)
    )
    .sort(
      (a, b) =>
        CANDIDATE_RANK[statusOf(a) ?? "available"] -
        CANDIDATE_RANK[statusOf(b) ?? "available"]
    );

  const fallbackHealth: FallbackHealth =
    fallbackModelIds.length === 0
      ? "none"
      : fallbackModelIds.some((modelId) => statusOf(modelId) === "available")
        ? "operational"
        : "degraded";

  return { fallbackModelIds, fallbackHealth };
}
