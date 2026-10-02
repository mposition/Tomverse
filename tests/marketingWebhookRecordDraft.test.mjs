import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookVerificationRecordSchema,
} from "../lib/marketingAutomationAccess.ts";
import { draftMarketingWebhookVerificationRecord } from "../lib/marketingWebhookRecordDraft.ts";

const digest = (n) => n.toString(16).padStart(64, "0");
const row = (n, overrides = {}) => ({
  eventIdDigest: digest(n),
  eventType: "post.platform.published",
  channelId: "channel-li",
  statusQueryMatch: true,
  ...overrides,
});

const base = {
  recordId: "2026-10-02__zernio-shadow",
  executor: "staging-operator",
  stagingCommitSha: "a".repeat(40),
  stagingConfigSnapshotDigest: "b".repeat(64),
  reports: [row(1), row(2), row(3, { eventType: "post.platform.deleted" })],
  faultArm: { eventIdDigest: digest(2), state: "consumed" },
  c1EvidenceRefs: ["railway-http:2026-10-02T10:56:11Z:200"],
  c2EvidenceRefs: ["railway-http:2026-10-02T10:51:50Z:401"],
  evidenceRefs: [],
};

test("stored rows that prove every condition make a strict record", () => {
  const draft = draftMarketingWebhookVerificationRecord(base);
  assert.equal(draft.ok, true);
  const record = JSON.parse(draft.fileText);
  assert.ok(marketingWebhookVerificationRecordSchema.safeParse(record).success);
  assert.equal(record.pipelineFingerprint, MARKETING_WEBHOOK_PIPELINE_FINGERPRINT);
  assert.deepEqual(record.observedScope, [
    { eventType: "post.platform.deleted", channelId: "channel-li" },
    { eventType: "post.platform.published", channelId: "channel-li" },
  ]);
  assert.equal(draft.recordDigest, digestMarketingWebhookVerificationRecord(draft.fileText));
  assert.deepEqual(draft.excludedPairs, []);
});

test("a pair with one disagreeing status query is left out of the scope", () => {
  const draft = draftMarketingWebhookVerificationRecord({
    ...base,
    reports: [...base.reports, row(4, { eventType: "post.platform.deleted", statusQueryMatch: false })],
  });
  assert.equal(draft.ok, true);
  assert.deepEqual(JSON.parse(draft.fileText).observedScope, [
    { eventType: "post.platform.published", channelId: "channel-li" },
  ]);
  assert.deepEqual(draft.excludedPairs, [{ eventType: "post.platform.deleted", channelId: "channel-li" }]);
});

test("a condition the rows do not prove refuses the whole record", () => {
  const cases = [
    [{ c1EvidenceRefs: [] }, "c1_evidence_missing"],
    [{ c2EvidenceRefs: [] }, "c2_evidence_missing"],
    [{ reports: [], faultArm: null }, "c3_no_reports"],
    [{ reports: [...base.reports, row(1)] }, "c3_duplicate_event"],
    [{ faultArm: null }, "c4_fault_not_consumed"],
    [{ faultArm: { eventIdDigest: digest(2), state: "armed" } }, "c4_fault_not_consumed"],
    [{ faultArm: { eventIdDigest: digest(9), state: "consumed" } }, "c4_fault_event_not_recorded_once"],
    [{ reports: base.reports.map((r) => ({ ...r, statusQueryMatch: false })) }, "c5_no_matching_pair"],
  ];
  for (const [override, problem] of cases) {
    const draft = draftMarketingWebhookVerificationRecord({ ...base, ...override });
    assert.equal(draft.ok, false, problem);
    assert.ok(draft.problems.includes(problem), `${problem}: ${draft.problems}`);
  }
});
