import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
  AMUX_SESSION_ANALYSIS_RESERVATION_POLICY_VERSION,
  AMUX_SESSION_ANALYSIS_RESERVATION_PROVIDERS,
  AMUX_SESSION_ANALYSIS_RESERVATION_REASONING_EFFORTS,
  AMUX_SESSION_ANALYSIS_RESERVATION_STATUS,
  AMUX_SESSION_ANALYSIS_RESERVATION_STATUSES,
  AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
  AMUX_SESSION_ANALYSIS_RESERVED_SCOPE,
  AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
  amuxSessionAnalysisReservationAuditMetadata,
} from "../lib/amux/ideaSessionAnalysisReservationCore.ts";

test("session analysis reservation uses one closed queue and system-audit contract", () => {
  assert.equal(AMUX_SESSION_ANALYSIS_RESERVATION_POLICY_VERSION, 19);
  assert.deepEqual(AMUX_SESSION_ANALYSIS_RESERVATION_STATUSES, ["queued"]);
  assert.deepEqual(AMUX_SESSION_ANALYSIS_RESERVATION_PROVIDERS,
    ["openai", "anthropic"]);
  assert.deepEqual(AMUX_SESSION_ANALYSIS_RESERVATION_REASONING_EFFORTS,
    ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(AMUX_SESSION_ANALYSIS_RESERVATION_STATUS, "queued");
  assert.equal(AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR, "amux-session-intake");
  assert.equal(AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
    "amux.idea.session_analysis_reserved");
  assert.equal(AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
    "AmuxIdeaSessionAnalysisReservation");
  assert.equal(AMUX_SESSION_ANALYSIS_RESERVED_SCOPE,
    "session-analysis-reservation-v1");
  assert.match(AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
    /Queued one AMUX v19 analysis reservation/);
});

test("session analysis reservation audit metadata is content-free and exact", () => {
  const metadata = amuxSessionAnalysisReservationAuditMetadata({
    reservationId: "fc29c198-6814-46de-8eb3-8b5735fbd2d4",
    ideaId: "2ee2b446-241d-4a41-aaff-bd41e2a65808",
    requestId: "ad1865d6-09ab-45f5-8fbf-3a01ff17cb02",
    submissionAuditId: "audit-session-submission",
    operatingScopeSettingId: "scope-19",
    dataOwnerUserId: "owner-1",
    modelProvider: "openai",
    modelId: "frontier-model",
    reasoningEffort: "high",
  });
  assert.deepEqual(metadata, {
    policyVersion: 19,
    reservationId: "fc29c198-6814-46de-8eb3-8b5735fbd2d4",
    ideaId: "2ee2b446-241d-4a41-aaff-bd41e2a65808",
    requestId: "ad1865d6-09ab-45f5-8fbf-3a01ff17cb02",
    submissionAuditId: "audit-session-submission",
    operatingScopeSettingId: "scope-19",
    dataOwnerUserId: "owner-1",
    modelProvider: "openai",
    modelId: "frontier-model",
    reasoningEffort: "high",
  });
  assert.doesNotMatch(JSON.stringify(metadata),
    /repository|pullRequest|path|ideaText|sourceProvenance|reservedMicroUsd/);
  assert.equal(Object.isFrozen(metadata), true);
});
