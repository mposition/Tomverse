import type { ModelTier } from "@/lib/models";

// Image generation gates, kept pure so both the server-only modules
// (lib/appSettings.ts, lib/billingEntitlements.ts) and unit tests can share
// one definition. See docs/policy/image-generation.md.

export const IMAGE_GENERATION_FLAG_KEY = "feature.imageGenerationEnabled";

// Explicit opt-in, unlike the default-on `feature.*` flags read through
// `enabledFromValue` in lib/appSettings.ts. A missing row, NULL, empty string
// or any value other than the literal "true" keeps the feature OFF. This is
// the fail-closed direction for a beta: forgetting to seed the flag must not
// open the feature.
export const imageGenerationEnabledFromValue = (
  value: string | null | undefined
): boolean => value === "true";

// Owner decision, 2026-10-28: every signed-in plan can use its existing credit
// allowance for images. Reservation still enforces the same balance, daily
// allowance, provider budget and concurrency limits; this grants no credits.
export const planAllowsImageGeneration = (tier: ModelTier): boolean =>
  tier === "Free" || tier === "Pro" || tier === "Max";
