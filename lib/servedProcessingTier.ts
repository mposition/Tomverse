import type { AiProvider } from "@/lib/models";

// Closes half of the gap recorded as RESPONSE_PROCESSING_TIER_IS_NOT_RECORDED
// in lib/modelPricing.ts.
//
// Every pricing profile declares `processingTier: "standard"`, and
// `check:model-pricing` proves no request *selects* a tier. What neither of
// them can prove is what the provider actually served: OpenAI treats an
// omitted `service_tier` as `auto`, and `auto` is free to serve a request at a
// tier whose price is not the Standard price the profiles record. Until now
// nothing on the chat path looked, so "we assume Standard" had no evidence
// behind it at all.
//
// This module is the looking. It classifies the tier a response came back on
// and says whether the Standard table was the right one to use. It is
// deliberately observation-only: nothing here writes a reservation, a
// settlement or a pricing snapshot, and the recorded gap stays open until
// something does. Being able to see the discrepancy is a prerequisite for
// pricing it, not a substitute.
//
// This file names `serviceTier` because it reads it off a response. It is in
// PROCESSING_TIER_REQUEST_ALLOWLIST with `sendsATier: false` for exactly that
// reason.

/**
 * What the provider reported, judged against the Standard price table.
 *
 * `absent` and `unknown` are kept apart on purpose. `absent` means the
 * provider said nothing, which is the normal case for every provider that has
 * no tier concept -- it is not evidence of anything. `unknown` means the
 * provider named a tier this code has never heard of, which is a real signal:
 * a tier nobody priced is being served.
 */
export type ServedTierClassification =
  | "standard"
  | "discounted"
  | "premium"
  | "absent"
  | "unknown";

export type ServedTierObservation = {
  provider: AiProvider;
  /** Exactly what the provider called it, or null when it said nothing. */
  servedTier: string | null;
  classification: ServedTierClassification;
  /**
   * True when the Standard table this application priced the request with is
   * not the table the provider billed it under. `absent` is never a mismatch:
   * silence is not a claim.
   */
  mismatchesAssumedStandard: boolean;
};

// OpenAI's published tiers. `default` is what the API calls Standard on the
// response, which is why it maps to "standard" rather than to "unknown".
const OPENAI_TIERS: Record<string, ServedTierClassification> = {
  default: "standard",
  standard: "standard",
  flex: "discounted",
  batch: "discounted",
  scale: "premium",
  priority: "premium",
};

/**
 * Reads the served tier out of the AI SDK's provider metadata.
 *
 * Shaped defensively rather than typed against one provider's metadata: the
 * value crosses a version boundary this application does not control, and a
 * shape change should degrade to `absent` instead of throwing on the chat
 * path at the moment a response completes.
 */
export const readServedProcessingTier = (
  provider: AiProvider,
  providerMetadata: unknown
): string | null => {
  if (!providerMetadata || typeof providerMetadata !== "object") return null;
  const byProvider = (providerMetadata as Record<string, unknown>)[provider];
  if (!byProvider || typeof byProvider !== "object") return null;
  const value = (byProvider as Record<string, unknown>).serviceTier;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export const classifyServedProcessingTier = (
  provider: AiProvider,
  servedTier: string | null
): ServedTierClassification => {
  if (!servedTier) return "absent";
  if (provider !== "openai") return "unknown";
  return OPENAI_TIERS[servedTier.toLowerCase()] ?? "unknown";
};

export const observeServedProcessingTier = (
  provider: AiProvider,
  providerMetadata: unknown
): ServedTierObservation => {
  const servedTier = readServedProcessingTier(provider, providerMetadata);
  const classification = classifyServedProcessingTier(provider, servedTier);
  return {
    provider,
    servedTier,
    classification,
    // A discounted tier is a mismatch too. Over-reserving is the safer
    // direction, but a profile that is wrong in the cheap direction is still
    // a profile that does not describe what was billed, and the register of
    // fallback-vs-settled ratios would quietly drift.
    mismatchesAssumedStandard:
      classification === "discounted" ||
      classification === "premium" ||
      classification === "unknown",
  };
};
