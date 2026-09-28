import {
  APP_DEFAULTS,
  GUEST_BRAND_TRIO_MODEL_IDS,
  resolveGuestDefaultSelectedModels,
} from "@/lib/appDefaults";

/**
 * What an adoption's "replace" option is allowed to do to a catalogue row.
 *
 * The application fallback is checked first: when it is also the guest lead,
 * the operator sees the fallback reason, which is the refusal the server
 * returns. A guest-trio member that is neither is only a warning. Disabling
 * it is still a registry write; the guest screen backfills from the fallback
 * list, and the warning is what says so before the click.
 */
export type ReplacementRole =
  | "application_fallback"
  | "guest_lead"
  | "guest_trio";

export const APPLICATION_FALLBACK_PROTECTED = "APPLICATION_FALLBACK_PROTECTED";
export const GUEST_LEAD_PROTECTED = "GUEST_LEAD_PROTECTED";

export const replacementRole = (
  modelId: string,
  effectiveGuestLeadId: string | null
): ReplacementRole | null => {
  if (modelId === APP_DEFAULTS.defaultModelId) return "application_fallback";
  if (effectiveGuestLeadId && modelId === effectiveGuestLeadId) return "guest_lead";
  if ((GUEST_BRAND_TRIO_MODEL_IDS as readonly string[]).includes(modelId)) {
    return "guest_trio";
  }
  return null;
};

export const replacementOptionDisabled = (role: ReplacementRole | null) =>
  role === "application_fallback" || role === "guest_lead";

/**
 * The model a guest's first conversation actually leads with.
 *
 * `storedLead` is the raw `AppSetting` value, including a missing row
 * (`null`). A missing or ineligible value is not "no lead": resolution falls
 * through to the compiled trio, which is what the guest screen does.
 */
export const effectiveGuestLeadModelId = (
  storedLead: string | null | undefined,
  isEligible: (modelId: string) => boolean
): string | null =>
  resolveGuestDefaultSelectedModels({
    isEligible,
    leadModelId: storedLead || APP_DEFAULTS.guestDefaultModelId,
  })[0] ?? null;

export type GuestDefaultDescription = {
  visibleIds: string[];
  effectiveLeadId: string | null;
  /** A stored value exists and it is not the model guests actually see first. */
  storedNotApplied: boolean;
  ineligibleTrioIds: string[];
  substituteIds: string[];
};

export const describeGuestDefault = ({
  storedLead,
  isEligible,
}: {
  storedLead: string | null;
  isEligible: (modelId: string) => boolean;
}): GuestDefaultDescription => {
  const visibleIds = resolveGuestDefaultSelectedModels({
    isEligible,
    leadModelId: storedLead || APP_DEFAULTS.guestDefaultModelId,
  });
  const effectiveLeadId = visibleIds[0] ?? null;
  return {
    visibleIds,
    effectiveLeadId,
    storedNotApplied: Boolean(storedLead) && storedLead !== effectiveLeadId,
    ineligibleTrioIds: GUEST_BRAND_TRIO_MODEL_IDS.filter((id) => !isEligible(id)),
    substituteIds: visibleIds.filter(
      (id) => !(GUEST_BRAND_TRIO_MODEL_IDS as readonly string[]).includes(id)
    ),
  };
};

/**
 * Who appears in the guest trio if `modelId` is no longer eligible.
 * Null when the id is not a trio member the operator can still turn off
 * (the fallback and the current lead are refused, not warned).
 */
export const substituteIfTrioMemberRemoved = (
  modelId: string,
  effectiveGuestLeadId: string | null,
  isEligible: (modelId: string) => boolean
): string | null => {
  if (replacementRole(modelId, effectiveGuestLeadId) !== "guest_trio") return null;
  const after = resolveGuestDefaultSelectedModels({
    isEligible: (id) => (id === modelId ? false : isEligible(id)),
    leadModelId: effectiveGuestLeadId || APP_DEFAULTS.guestDefaultModelId,
  });
  const before = resolveGuestDefaultSelectedModels({
    isEligible,
    leadModelId: effectiveGuestLeadId || APP_DEFAULTS.guestDefaultModelId,
  });
  return after.find((id) => !before.includes(id)) ?? null;
};

export const FALLBACK_TRANSITION_CHECKS = [
  "registry_live",
  "guest_plan",
  "standard_class",
  "credit_ceiling",
  "code_catalog",
  "pricing_profile",
] as const;

export type FallbackTransitionCheckId = (typeof FALLBACK_TRANSITION_CHECKS)[number];

export type FallbackTransitionCandidate = {
  enabled: boolean;
  publiclyListed: boolean;
  catalogDeleted: boolean;
  status: string;
  minimumPlan: string;
  usageClass: string;
  creditWeight: number;
};

export const assessFallbackTransition = ({
  candidate,
  inCodeCatalog,
  hasPricingProfile,
  fallbackCreditWeight,
}: {
  candidate: FallbackTransitionCandidate | null;
  inCodeCatalog: boolean;
  hasPricingProfile: boolean;
  fallbackCreditWeight: number;
}): Array<{ id: FallbackTransitionCheckId; pass: boolean }> => {
  const live = Boolean(
    candidate &&
      candidate.enabled &&
      candidate.publiclyListed &&
      !candidate.catalogDeleted &&
      candidate.status === "enabled"
  );
  return [
    { id: "registry_live", pass: live },
    { id: "guest_plan", pass: candidate?.minimumPlan === "Guest" },
    { id: "standard_class", pass: candidate?.usageClass === "standard" },
    {
      id: "credit_ceiling",
      pass: Boolean(candidate) && candidate!.creditWeight <= fallbackCreditWeight,
    },
    { id: "code_catalog", pass: inCodeCatalog },
    { id: "pricing_profile", pass: hasPricingProfile },
  ];
};

/**
 * Text an operator pastes into a review. It names the candidate and the
 * checks. It does not change a default, and it carries no secret.
 */
export const fallbackTransitionRequestText = ({
  candidateId,
  checks,
}: {
  candidateId: string;
  checks: ReadonlyArray<{ id: FallbackTransitionCheckId; pass: boolean }>;
}) => {
  const lines = checks.map((check) => `- ${check.id}: ${check.pass ? "pass" : "fail"}`);
  return [
    "Application fallback transition request",
    `Candidate: ${candidateId}`,
    "Copying this does not change the default.",
    "",
    "Checks:",
    ...lines,
    "",
    "A reviewed code change still has to move, together:",
    "- DEFAULT_MODEL_ID",
    "- APP_DEFAULTS.defaultModelId",
    "- Prisma UserSettings.defaultModel column default",
    "- the user-settings create path",
    "Guest trio membership (GUEST_BRAND_TRIO_MODEL_IDS) is a separate decision.",
    "Existing accounts and conversations are not moved by this request.",
  ].join("\n");
};
