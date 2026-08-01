// STG-R002: pure decision logic for administrator-triggered provider
// verification and verified recovery. Dependency-free (no Prisma, no
// "server-only") so every rule below is unit-testable with fixtures and a mock
// clock, and so the route handler, the DB layer and the tests can never
// disagree about when a recovery is allowed.
//
// The rule this module exists to enforce: a provider's blocking failure
// counter may only ever be cleared by a *successful, recent, not-yet-consumed*
// live verification call. There is deliberately no path here that clears it on
// its own.

/** What one live verification attempt concluded. */
export type ProviderVerificationStatus =
  /** The provider answered the verification request. */
  | "success"
  /** The provider was reached and rejected or failed the request. */
  | "failed"
  /** The check could not be attempted at all (no key, no eligible model). */
  | "unavailable";

/**
 * How long an administrator must wait between live verification calls for the
 * same provider. These calls cost real provider money, so the cooldown is a
 * spend guard as much as a rate limit -- it stops a frustrated operator (or a
 * double-click, or a retrying tab) from firing a burst of billable requests.
 */
export const DEFAULT_VERIFICATION_COOLDOWN_SECONDS = 60;

/**
 * How long a successful verification stays usable as recovery authorisation.
 * Long enough for an operator to read the result and decide; short enough that
 * "it worked half an hour ago" can never be presented as "it works now".
 */
export const DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS = 15 * 60;

const secondsBetween = (later: Date, earlier: Date) =>
  (later.getTime() - earlier.getTime()) / 1_000;

const isUsableTimestamp = (value: Date | null | undefined): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

/**
 * Seconds an operator must still wait before another verification call is
 * allowed. 0 means "allowed now". A future-dated last attempt (clock skew,
 * tampering) is treated as a full cooldown rather than trusted.
 */
export const verificationCooldownRemainingSeconds = ({
  now,
  lastAttemptAt,
  cooldownSeconds = DEFAULT_VERIFICATION_COOLDOWN_SECONDS,
}: {
  now: Date;
  lastAttemptAt: Date | null | undefined;
  cooldownSeconds?: number;
}): number => {
  const safeCooldown = Math.max(
    0,
    Math.floor(
      Number.isFinite(cooldownSeconds)
        ? cooldownSeconds
        : DEFAULT_VERIFICATION_COOLDOWN_SECONDS
    )
  );
  if (safeCooldown === 0) return 0;
  if (!isUsableTimestamp(lastAttemptAt)) return 0;

  const elapsed = secondsBetween(now, lastAttemptAt);
  if (elapsed < 0) return safeCooldown;
  return Math.max(0, Math.ceil(safeCooldown - elapsed));
};

export type RecoveryRejectionReason =
  /** No verification evidence was supplied or found. */
  | "NO_VERIFICATION"
  /** The supplied evidence belongs to a different provider. */
  | "PROVIDER_MISMATCH"
  /** The verification did not succeed, so it authorises nothing. */
  | "VERIFICATION_FAILED"
  /** The verification succeeded but is too old to describe the provider now. */
  | "VERIFICATION_STALE"
  /** This verification has already been used to clear a block. */
  | "VERIFICATION_ALREADY_CONSUMED"
  /** The provider is not currently blocked, so there is nothing to clear. */
  | "NOT_BLOCKED";

export type RecoveryEvidence = {
  provider: string;
  kind: string;
  status: string;
  createdAt: Date;
  recoveryApplied: boolean;
};

export type RecoveryEligibility =
  | { allowed: true }
  | { allowed: false; reason: RecoveryRejectionReason; detail: string };

/** The `kind` discriminator marking a ProviderHealthCheck row as a live call. */
export const LIVE_VERIFICATION_KIND = "live_verification";

/**
 * Decides whether one piece of verification evidence may clear a provider's
 * blocking failure counter right now.
 *
 * Every rejection path returns a reason code so the caller can audit *why* a
 * recovery was refused -- "provider_recovery_rejected" with no explanation is
 * not an auditable event.
 */
export const evaluateRecoveryEligibility = ({
  now,
  provider,
  evidence,
  consecutiveFailures,
  maxEvidenceAgeSeconds = DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS,
}: {
  now: Date;
  provider: string;
  evidence: RecoveryEvidence | null | undefined;
  consecutiveFailures: number;
  maxEvidenceAgeSeconds?: number;
}): RecoveryEligibility => {
  if (!evidence) {
    return {
      allowed: false,
      reason: "NO_VERIFICATION",
      detail:
        "No verification result was supplied, and a provider block can only be cleared by a successful live verification.",
    };
  }
  if (evidence.provider !== provider || evidence.kind !== LIVE_VERIFICATION_KIND) {
    return {
      allowed: false,
      reason: "PROVIDER_MISMATCH",
      detail:
        "The supplied verification result does not belong to this provider's live verification log.",
    };
  }
  if (evidence.status !== "success") {
    return {
      allowed: false,
      reason: "VERIFICATION_FAILED",
      detail:
        "The referenced verification did not succeed, so it cannot authorise clearing the provider block.",
    };
  }
  if (evidence.recoveryApplied) {
    return {
      allowed: false,
      reason: "VERIFICATION_ALREADY_CONSUMED",
      detail:
        "This verification has already been used to recover the provider. Run a new verification first.",
    };
  }

  const safeMaxAge = Math.max(
    1,
    Math.floor(
      Number.isFinite(maxEvidenceAgeSeconds)
        ? maxEvidenceAgeSeconds
        : DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS
    )
  );
  const ageSeconds = isUsableTimestamp(evidence.createdAt)
    ? secondsBetween(now, evidence.createdAt)
    : Number.POSITIVE_INFINITY;
  if (!(ageSeconds >= 0) || ageSeconds > safeMaxAge) {
    return {
      allowed: false,
      reason: "VERIFICATION_STALE",
      detail: `The referenced verification is older than the ${Math.round(
        safeMaxAge / 60
      )}-minute evidence window. Run a new verification first.`,
    };
  }

  if (Math.max(0, Math.floor(consecutiveFailures)) <= 0) {
    return {
      allowed: false,
      reason: "NOT_BLOCKED",
      detail:
        "This provider has no consecutive failure block to clear, so no recovery is required.",
    };
  }

  return { allowed: true };
};

/**
 * Whether the admin UI should offer the recovery action at all. Kept here (not
 * in the component) so the button's enabled state and the API's authorisation
 * check are derived from the same rules -- a disabled button is a courtesy,
 * never the control.
 */
export const canOfferRecovery = ({
  publicStatus,
  consecutiveFailures,
  eligibility,
}: {
  publicStatus: string;
  consecutiveFailures: number;
  eligibility: RecoveryEligibility;
}) =>
  eligibility.allowed &&
  Math.max(0, Math.floor(consecutiveFailures)) > 0 &&
  (publicStatus === "incident" || publicStatus === "degraded");
