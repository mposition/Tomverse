// What to do with a presented refresh token.
//
// Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
// D5 (order), D7 (atomic rotation), D8 (reuse semantics), section 4 option A
// (strict single use), approved 2026-08-31.
//
// ## The order is the security property
//
// D5 fixes three steps and refuses to let them commute:
//
//   1. look the record up by id      -> unknown id: refuse, family untouched
//   2. compare the secret            -> mismatch:   refuse, family untouched
//   3. only now judge state          -> consumed or invalidated: reuse (D8)
//
// Reversed, an attacker who knows only a record id can destroy any family they
// name. The id is the front half of the token, is not a secret, and is exactly
// the sort of value that ends up in a log line by accident. Reuse detection
// would become an unauthenticated denial of service against any session whose
// id leaked.
//
// So the comparison is not a boolean argument to this function -- a caller
// could compute that in the wrong order and this file would never know. It is a
// thunk, called from step 2, and the state checks are physically after it.
//
// ## Option A
//
// Strict single use. A presented record that is already consumed or invalidated
// destroys the family, with no window and no idempotency key. The packet's
// section 4 records why B-2 was held and what B-1 would cost; neither is
// implemented, and there is no code path here that could be mistaken for one.

/** Everything about a stored rotation row this decision needs. */
export type MobileRefreshRecord = {
  id: string;
  familyId: string;
  /** Which pepper generation `secretDigest` was computed under. */
  pepperKid: string;
  expiresAtMs: number;
  consumedAtMs: number | null;
  invalidatedAtMs: number | null;
};

/** Everything about the family and its device this decision needs. */
export type MobileFamilyState = {
  familyId: string;
  deviceId: string;
  userId: string;
  createdAtMs: number;
  lastRotatedAtMs: number;
  absoluteExpiresAtMs: number;
  revokedAtMs: number | null;
  deviceRevokedAtMs: number | null;
  /** `active`, or anything else. Non-active loses the session, as on the web. */
  accountStatus: string;
};

export type MobileRefreshDecision =
  /** Rotate: consume this record and mint its successor, atomically (D7). */
  | { kind: "rotate"; record: MobileRefreshRecord; family: MobileFamilyState }
  /**
   * Reuse detected. The family must be revoked, and that revocation must commit
   * even though the caller answers 401 (D8's commit contract).
   */
  | { kind: "reuse_detected"; familyId: string; reason: "consumed" | "invalidated" }
  /** Refuse, and leave every family exactly as it was. */
  | {
      kind: "reject";
      reason:
        | "unknown_record"
        | "secret_mismatch"
        | "family_missing"
        | "family_revoked"
        | "device_revoked"
        | "account_not_active"
        | "record_expired"
        | "family_absolute_expired"
        | "family_idle_expired";
    };

export type MobileRefreshInputs = {
  /** Looked up by the id half of the presented token. Null when there is none. */
  record: MobileRefreshRecord | null;
  /**
   * Constant-time comparison of the presented secret against the stored digest.
   *
   * A thunk, not a boolean: it is invoked here, at step 2, so no caller can
   * arrive at step 3 without having gone through it.
   */
  secretMatches: (record: MobileRefreshRecord) => boolean;
  /** The record's family, when the record exists. */
  family: MobileFamilyState | null;
  nowMs: number;
  idleWindowMs: number;
};

export const decideMobileRefresh = (
  input: MobileRefreshInputs
): MobileRefreshDecision => {
  // --- 1. the record exists ----------------------------------------------
  const { record } = input;
  if (!record) return { kind: "reject", reason: "unknown_record" };

  // --- 2. the secret matches ---------------------------------------------
  //
  // Before any state is judged. A wrong secret is refused with the family
  // untouched even when the record it names is consumed or invalidated --
  // which is the branch V24b and V24c exist to hold.
  if (!input.secretMatches(record)) {
    return { kind: "reject", reason: "secret_mismatch" };
  }

  // --- 3. state ------------------------------------------------------------
  //
  // Reuse is judged first among the state checks. A replayed token whose family
  // has also expired is still a replay: the copy exists either way, and the
  // family should be revoked rather than merely allowed to lapse.
  if (record.consumedAtMs !== null) {
    return { kind: "reuse_detected", familyId: record.familyId, reason: "consumed" };
  }
  if (record.invalidatedAtMs !== null) {
    return {
      kind: "reuse_detected",
      familyId: record.familyId,
      reason: "invalidated",
    };
  }

  const { family } = input;
  if (!family) return { kind: "reject", reason: "family_missing" };
  if (family.revokedAtMs !== null) {
    return { kind: "reject", reason: "family_revoked" };
  }
  if (family.deviceRevokedAtMs !== null) {
    return { kind: "reject", reason: "device_revoked" };
  }
  if (family.accountStatus !== "active") {
    return { kind: "reject", reason: "account_not_active" };
  }
  if (input.nowMs >= record.expiresAtMs) {
    return { kind: "reject", reason: "record_expired" };
  }
  if (input.nowMs >= family.absoluteExpiresAtMs) {
    return { kind: "reject", reason: "family_absolute_expired" };
  }
  if (input.nowMs - family.lastRotatedAtMs >= input.idleWindowMs) {
    return { kind: "reject", reason: "family_idle_expired" };
  }

  return { kind: "rotate", record, family };
};

/**
 * Whether a rotation should re-mint the successor under the current pepper.
 *
 * 8.1.1 #3: a retired pepper stays verifiable for the idle window plus skew,
 * and a successful refresh moves the family onto the current generation. So a
 * record verified under an old pepper still rotates -- it just does not hand
 * its successor the same old generation.
 */
export const successorPepperKid = (input: {
  recordPepperKid: string;
  currentPepperKid: string;
}) => input.currentPepperKid;

/** True when this rotation migrated the family off a retired pepper. */
export const rotationMigratedPepper = (input: {
  recordPepperKid: string;
  currentPepperKid: string;
}) => input.recordPepperKid !== input.currentPepperKid;
