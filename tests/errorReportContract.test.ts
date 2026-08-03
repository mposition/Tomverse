import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_AVAILABILITY,
  TOKEN_VERIFICATION_STATUS,
  TRACE_PROVENANCE,
  traceEvidenceRecordability,
} from "../lib/errorReportContract";

/**
 * The recordability policy: which server-classified errors get their own
 * evidence row, which point at existing operational records, and which
 * record nothing new. The vocabulary itself is asserted too -- these strings
 * are stored on Feedback rows and rendered by the admin inbox, so a renamed
 * constant is a data migration, not a refactor.
 */

test("application and provider failures are evidence-worthy", () => {
  assert.deepEqual(traceEvidenceRecordability("AI_PROVIDER_ERROR", 500), {
    record: true,
  });
  assert.deepEqual(traceEvidenceRecordability("AI_REQUEST_FAILED", 500), {
    record: true,
  });
  // The deep-research failed poll is a 200 response carrying a terminal
  // failure -- the code decides, not the status.
  assert.deepEqual(traceEvidenceRecordability("DEEP_RESEARCH_JOB_FAILED", 200), {
    record: true,
  });
  assert.deepEqual(traceEvidenceRecordability("AI_EMPTY_RESPONSE", 200), {
    record: true,
  });
  assert.deepEqual(traceEvidenceRecordability("SOME_NEW_FAILURE", 500), {
    record: true,
  });
});

test("limit and entitlement rejections defer to their existing records", () => {
  for (const code of [
    "CHAT_RATE_LIMITED",
    "CHAT_QUOTA_EXCEEDED",
    "CHAT_CONCURRENCY_EXCEEDED",
    "CHAT_IP_CONCURRENCY_EXCEEDED",
    "PLAN_ENTITLEMENT_EXHAUSTED",
    "CREDIT_BALANCE_INSUFFICIENT",
    "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
    "PROVIDER_BUDGET_EXHAUSTED",
  ]) {
    const outcome = traceEvidenceRecordability(code, 429);
    assert.equal(outcome.record, false, code);
    assert.equal(
      !outcome.record && outcome.availability,
      EVIDENCE_AVAILABILITY.existingLimitEvent,
      code
    );
  }
});

test("routine request rejections record nothing new", () => {
  for (const code of [
    "TURNSTILE_REQUIRED",
    "INVALID_REQUEST",
    "NOT_FOUND",
    "AUTH_REQUIRED",
    "CONVERSATION_FORBIDDEN",
  ]) {
    const outcome = traceEvidenceRecordability(code, 400);
    assert.equal(outcome.record, false, code);
    assert.equal(
      !outcome.record && outcome.availability,
      EVIDENCE_AVAILABILITY.intentionallyNotRecorded,
      code
    );
  }
  // Unlisted 4xx codes default to not recording -- widening the recordable
  // set is a policy change, never a side effect.
  const unlisted = traceEvidenceRecordability("SOME_UNLISTED_CODE", 403);
  assert.equal(unlisted.record, false);
});

test("the stored vocabulary is stable", () => {
  assert.equal(TRACE_PROVENANCE.serverGenerated, "server_generated");
  assert.equal(TRACE_PROVENANCE.clientSupplied, "client_supplied");
  assert.equal(TRACE_PROVENANCE.clientFallback, "client_fallback");
  assert.equal(TOKEN_VERIFICATION_STATUS.verified, "verified");
  assert.equal(TOKEN_VERIFICATION_STATUS.missingToken, "missing_token");
  assert.equal(TOKEN_VERIFICATION_STATUS.payloadMismatch, "payload_mismatch");
  assert.equal(
    TOKEN_VERIFICATION_STATUS.untrustedTraceSource,
    "untrusted_trace_source"
  );
  assert.equal(EVIDENCE_AVAILABILITY.recorded, "recorded");
  assert.equal(
    EVIDENCE_AVAILABILITY.intentionallyNotRecorded,
    "intentionally_not_recorded"
  );
  assert.equal(EVIDENCE_AVAILABILITY.notYetAvailable, "not_yet_available");
});
