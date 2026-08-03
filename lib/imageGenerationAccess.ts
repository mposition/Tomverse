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

// Plan entitlement is a code default on the plan tier, deliberately not a
// BillingPlanConfig column: PR 1 must not carry a schema migration, and the
// Pro/Max-only beta is a product decision rather than a per-plan admin knob.
// If an admin override becomes necessary it moves to a DB-backed field in a
// schema PR, with this function as the documented fallback for NULL.
export const planAllowsImageGeneration = (tier: ModelTier): boolean =>
  tier === "Pro" || tier === "Max";
