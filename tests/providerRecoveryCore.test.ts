import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS,
  DEFAULT_VERIFICATION_COOLDOWN_SECONDS,
  LIVE_VERIFICATION_KIND,
  canOfferRecovery,
  evaluateRecoveryEligibility,
  verificationCooldownRemainingSeconds,
  type RecoveryEvidence,
} from "../lib/providerRecoveryCore.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1_000);
const secondsFromNow = (seconds: number) =>
  new Date(NOW.getTime() + seconds * 1_000);

const successfulEvidence = (
  overrides: Partial<RecoveryEvidence> = {}
): RecoveryEvidence => ({
  provider: "perplexity",
  kind: LIVE_VERIFICATION_KIND,
  status: "success",
  createdAt: secondsAgo(30),
  recoveryApplied: false,
  ...overrides,
});

test("a successful, recent, unconsumed verification authorises a recovery", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence(),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, true);
});

test("a failed verification never authorises a recovery", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({ status: "failed" }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "VERIFICATION_FAILED"
  );
});

test("an unavailable verification never authorises a recovery", () => {
  // "unavailable" means the call was never attempted (no API key, no eligible
  // model), so it is evidence of a configuration gap, not of the provider.
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({ status: "unavailable" }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "VERIFICATION_FAILED"
  );
});

test("missing evidence is refused: there is no verification-free reset path", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: null,
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "NO_VERIFICATION"
  );
});

test("a verification for another provider cannot recover this one", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({ provider: "openai" }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "PROVIDER_MISMATCH"
  );
});

test("a configuration readiness check cannot stand in for a live verification", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({ kind: "configuration" }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "PROVIDER_MISMATCH"
  );
});

test("an already-consumed verification cannot recover a second time", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({ recoveryApplied: true }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "VERIFICATION_ALREADY_CONSUMED"
  );
});

test("verification evidence expires", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({
      createdAt: secondsAgo(DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS + 60),
    }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "VERIFICATION_STALE"
  );
});

test("a future-dated verification is treated as stale, never as fresh", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence({ createdAt: secondsFromNow(600) }),
    consecutiveFailures: 5,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "VERIFICATION_STALE"
  );
});

test("a provider with no block has nothing to recover", () => {
  const eligibility = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence(),
    consecutiveFailures: 0,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(
    eligibility.allowed === false ? eligibility.reason : null,
    "NOT_BLOCKED"
  );
});

test("the cooldown counts down and then clears", () => {
  assert.equal(
    verificationCooldownRemainingSeconds({
      now: NOW,
      lastAttemptAt: secondsAgo(10),
      cooldownSeconds: 60,
    }),
    50
  );
  assert.equal(
    verificationCooldownRemainingSeconds({
      now: NOW,
      lastAttemptAt: secondsAgo(60),
      cooldownSeconds: 60,
    }),
    0
  );
  assert.equal(
    verificationCooldownRemainingSeconds({ now: NOW, lastAttemptAt: null }),
    0
  );
});

test("a future-dated last attempt is charged a full cooldown rather than trusted", () => {
  assert.equal(
    verificationCooldownRemainingSeconds({
      now: NOW,
      lastAttemptAt: secondsFromNow(3_600),
    }),
    DEFAULT_VERIFICATION_COOLDOWN_SECONDS
  );
});

test("the recovery control is only offered on a blocked provider with usable evidence", () => {
  const eligible = evaluateRecoveryEligibility({
    now: NOW,
    provider: "perplexity",
    evidence: successfulEvidence(),
    consecutiveFailures: 5,
  });
  assert.equal(
    canOfferRecovery({
      publicStatus: "incident",
      consecutiveFailures: 5,
      eligibility: eligible,
    }),
    true
  );
  assert.equal(
    canOfferRecovery({
      publicStatus: "operational",
      consecutiveFailures: 5,
      eligibility: eligible,
    }),
    false
  );
  assert.equal(
    canOfferRecovery({
      publicStatus: "incident",
      consecutiveFailures: 0,
      eligibility: eligible,
    }),
    false
  );
  assert.equal(
    canOfferRecovery({
      publicStatus: "incident",
      consecutiveFailures: 5,
      eligibility: evaluateRecoveryEligibility({
        now: NOW,
        provider: "perplexity",
        evidence: successfulEvidence({ status: "failed" }),
        consecutiveFailures: 5,
      }),
    }),
    false
  );
});
