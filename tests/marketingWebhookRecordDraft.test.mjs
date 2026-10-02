import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookVerificationRecordSchema,
} from "../lib/marketingAutomationAccess.ts";
import { marketingWebhookEventIdDigest } from "../lib/marketingWebhookCore.ts";
import { draftMarketingWebhookVerificationRecord } from "../lib/marketingWebhookRecordDraft.ts";

const PUBLISHED = "post.platform.published";
const DELETED = "post.platform.deleted";
const id = (n) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const report = (n, eventType = PUBLISHED, overrides = {}) => ({
  eventIdDigest: marketingWebhookEventIdDigest("zernio", id(n)),
  eventType,
  channelId: "channel-li",
  statusQueryMatch: true,
  ...overrides,
});
const at = (minute) => `2026-10-03T01:${String(minute).padStart(2, "0")}:00.000Z`;
const delivery = (n, minute, statusCode, answer, event = PUBLISHED) => ({
  eventId: id(n),
  event,
  at: at(minute),
  statusCode,
  answer,
});

// Event 1: recorded, then redelivered (condition 3). Event 2: delivered while
// the shadow was off, armed, failed once on purpose, then recorded (condition 4).
const provedPublished = [
  delivery(1, 1, 200, "recorded"),
  delivery(1, 2, 200, "duplicate"),
  delivery(2, 3, 200, "shadow_off"),
  delivery(2, 5, 503, "deliberate_fault"),
  delivery(2, 6, 200, "recorded"),
];
const base = {
  recordId: "2026-10-03__zernio-shadow",
  executor: "staging-operator",
  stagingCommitSha: "a".repeat(40),
  stagingConfigSnapshotDigest: "b".repeat(64),
  reports: [report(1), report(2)],
  deliveries: [delivery(9, 0, 401, "signature_invalid", "webhook.test"), ...provedPublished],
  c2EvidenceRefs: ["probe:tampered-body:401"],
  evidenceRefs: [],
};

test("a type that proved every condition is in a strict record", () => {
  const draft = draftMarketingWebhookVerificationRecord(base);
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const record = JSON.parse(draft.fileText);
  assert.ok(marketingWebhookVerificationRecordSchema.safeParse(record).success);
  assert.equal(record.pipelineFingerprint, MARKETING_WEBHOOK_PIPELINE_FINGERPRINT);
  assert.deepEqual(record.observedScope, [{ eventType: PUBLISHED, channelId: "channel-li" }]);
  assert.equal(draft.recordDigest, digestMarketingWebhookVerificationRecord(draft.fileText));
  assert.ok(record.evidenceRefs.includes("probe:tampered-body:401"));
  assert.ok(record.evidenceRefs.some((ref) => ref.includes(":503:deliberate_fault")));
});

test("a type is in scope only when it proved conditions 1, 3 and 4 itself", () => {
  // A deleted event recorded once: condition 1 only.
  const draft = draftMarketingWebhookVerificationRecord({
    ...base,
    reports: [...base.reports, report(3, DELETED)],
    deliveries: [...base.deliveries, delivery(3, 7, 200, "recorded", DELETED)],
  });
  assert.equal(draft.ok, true);
  assert.deepEqual(JSON.parse(draft.fileText).observedScope, [{ eventType: PUBLISHED, channelId: "channel-li" }]);
  assert.deepEqual(draft.excludedTypes, [{ eventType: DELETED, missing: ["c3", "c4"] }]);
});

test("rows alone, without the delivery order, prove neither 3 nor 4", () => {
  const draft = draftMarketingWebhookVerificationRecord({
    ...base,
    deliveries: [base.deliveries[0], delivery(1, 1, 200, "recorded"), delivery(2, 3, 200, "recorded")],
  });
  assert.equal(draft.ok, false);
  assert.deepEqual(draft.excludedTypes, [{ eventType: PUBLISHED, missing: ["c3", "c4"] }]);
});

test("a fault armed on an event already recorded does not prove 4", () => {
  const draft = draftMarketingWebhookVerificationRecord({
    ...base,
    deliveries: [
      base.deliveries[0],
      delivery(1, 1, 200, "recorded"),
      delivery(1, 2, 200, "duplicate"),
      delivery(1, 4, 503, "deliberate_fault"),
    ],
    reports: [report(1)],
  });
  assert.equal(draft.ok, false);
  assert.deepEqual(draft.excludedTypes, [{ eventType: PUBLISHED, missing: ["c4"] }]);
});

test("a failure with no later recording, or two later recordings, does not prove 4", () => {
  for (const tail of [[], [delivery(2, 6, 200, "recorded"), delivery(2, 7, 200, "recorded")]]) {
    const draft = draftMarketingWebhookVerificationRecord({
      ...base,
      deliveries: [...base.deliveries.slice(0, 3), delivery(2, 3, 200, "shadow_off"), delivery(2, 5, 503, "deliberate_fault"), ...tail],
    });
    assert.equal(draft.ok, false, JSON.stringify(tail));
    assert.ok(draft.excludedTypes[0].missing.includes("c4"));
  }
});

test("a pair whose status query disagreed is left out of a proved type", () => {
  const draft = draftMarketingWebhookVerificationRecord({
    ...base,
    reports: [...base.reports, report(4, PUBLISHED, { channelId: "channel-fb", statusQueryMatch: false })],
    deliveries: [...base.deliveries, delivery(4, 8, 200, "recorded")],
  });
  assert.equal(draft.ok, true);
  assert.deepEqual(JSON.parse(draft.fileText).observedScope, [{ eventType: PUBLISHED, channelId: "channel-li" }]);
  assert.deepEqual(draft.excludedPairs, [{ eventType: PUBLISHED, channelId: "channel-fb" }]);
});

test("condition 2 needs a refused delivery and the executor's tampered-body reference", () => {
  const noRefusal = draftMarketingWebhookVerificationRecord({ ...base, deliveries: provedPublished });
  assert.deepEqual(noRefusal.problems, ["c2_no_refused_delivery"]);
  const noProbe = draftMarketingWebhookVerificationRecord({ ...base, c2EvidenceRefs: [] });
  assert.deepEqual(noProbe.problems, ["c2_evidence_missing"]);
});
