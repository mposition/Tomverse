import {
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_SCOPE,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "../adminAuditSystemActors.ts";

export const AMUX_V19_TRACKED_CHECKOUT_POLICY_VERSION = 19;
export const AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR =
  AMUX_V4_IDEA_SYSTEM_ACTOR;
export const AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY =
  "Recorded one content-free AMUX v19 pinned checkout evidence.";
export {
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_SCOPE,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
};

const FULL_COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HMAC_SHA256 = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type AmuxTrackedCheckoutEvidenceInput = {
  ideaId: string;
  referenceOrdinal: number;
  pinnedCommitSha: string;
  excludedCount: number;
  excludedPathDigest: string;
  excludedPathDigestKeyId: string;
  excludedReasons: {
    secret_path: number;
    secret_content: number;
    non_regular: number;
    unscannable_content: number;
  };
};

export type ValidAmuxTrackedCheckoutEvidence = Readonly<{
  ideaId: string;
  referenceOrdinal: number;
  pinnedCommitSha: string;
  excludedCount: number;
  excludedPathDigest: string;
  excludedPathDigestKeyId: string;
  excludedSecretPathCount: number;
  excludedSecretContentCount: number;
  excludedNonRegularCount: number;
  excludedUnscannableCount: number;
}>;

const nonnegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Validate only the content-free projection of a prepared checkout. File
 * paths and the temporary directory are deliberately absent from this type. */
export function inspectAmuxTrackedCheckoutEvidence(
  input: AmuxTrackedCheckoutEvidenceInput,
): ValidAmuxTrackedCheckoutEvidence | null {
  if (!input || typeof input !== "object" ||
      typeof input.ideaId !== "string" || input.ideaId.length === 0 ||
      !nonnegativeSafeInteger(input.referenceOrdinal) ||
      typeof input.pinnedCommitSha !== "string" ||
      !FULL_COMMIT_SHA.test(input.pinnedCommitSha) ||
      !nonnegativeSafeInteger(input.excludedCount) ||
      typeof input.excludedPathDigest !== "string" ||
      !HMAC_SHA256.test(input.excludedPathDigest) ||
      typeof input.excludedPathDigestKeyId !== "string" ||
      !KEY_ID.test(input.excludedPathDigestKeyId) ||
      !input.excludedReasons || typeof input.excludedReasons !== "object") {
    return null;
  }
  const reasons = input.excludedReasons;
  if (!nonnegativeSafeInteger(reasons.secret_path) ||
      !nonnegativeSafeInteger(reasons.secret_content) ||
      !nonnegativeSafeInteger(reasons.non_regular) ||
      !nonnegativeSafeInteger(reasons.unscannable_content) ||
      reasons.secret_path + reasons.secret_content + reasons.non_regular +
        reasons.unscannable_content !== input.excludedCount) {
    return null;
  }
  return Object.freeze({
    ideaId: input.ideaId,
    referenceOrdinal: input.referenceOrdinal,
    pinnedCommitSha: input.pinnedCommitSha,
    excludedCount: input.excludedCount,
    excludedPathDigest: input.excludedPathDigest,
    excludedPathDigestKeyId: input.excludedPathDigestKeyId,
    excludedSecretPathCount: reasons.secret_path,
    excludedSecretContentCount: reasons.secret_content,
    excludedNonRegularCount: reasons.non_regular,
    excludedUnscannableCount: reasons.unscannable_content,
  });
}

export function amuxTrackedCheckoutEvidenceAuditMetadata(
  evidenceId: string,
  input: ValidAmuxTrackedCheckoutEvidence,
) {
  return Object.freeze({
    policyVersion: AMUX_V19_TRACKED_CHECKOUT_POLICY_VERSION,
    evidenceId,
    ideaId: input.ideaId,
    referenceOrdinal: input.referenceOrdinal,
    pinnedCommitSha: input.pinnedCommitSha,
    excludedCount: input.excludedCount,
    excludedSecretPathCount: input.excludedSecretPathCount,
    excludedSecretContentCount: input.excludedSecretContentCount,
    excludedNonRegularCount: input.excludedNonRegularCount,
    excludedUnscannableCount: input.excludedUnscannableCount,
    excludedPathDigest: input.excludedPathDigest,
    excludedPathDigestKeyId: input.excludedPathDigestKeyId,
  });
}
