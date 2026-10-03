import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  digestMarketingWebhookVerificationRecord,
} from "../lib/marketingAutomationAccess.ts";
import {
  MarketingWebhookVerificationRefusedError,
  checkMarketingWebhookRecordForSigning,
  marketingWebhookVerificationRecordPath,
} from "../lib/marketingWebhookVerification.ts";

const record = {
  recordId: "2026-10-02__zernio-shadow",
  executor: "staging-operator",
  stagingCommitSha: "a".repeat(40),
  observedScope: [{ eventType: "post.platform.published", channelId: "channel-1" }],
  conditions: { c1: "pass", c2: "pass", c3: "pass", c4: "pass", c5: "pass" },
  evidenceRefs: ["artifact://marketing-webhook/c1-c5"],
  pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  stagingConfigSnapshotDigest: "b".repeat(64),
};
const fileText = `${JSON.stringify(record, null, 2)}\n`;
const recordDigest = digestMarketingWebhookVerificationRecord(fileText);

const refusalCode = (input) => {
  try {
    checkMarketingWebhookRecordForSigning(input);
  } catch (error) {
    assert.ok(error instanceof MarketingWebhookVerificationRefusedError);
    return error.code;
  }
  return null;
};

test("the record the operator read is signable", () => {
  assert.equal(refusalCode({ recordId: record.recordId, recordDigest, fileText }), null);
  // The digest is over canonical bytes: a CRLF checkout of the same record signs alike.
  assert.equal(
    refusalCode({ recordId: record.recordId, recordDigest, fileText: fileText.replaceAll("\n", "\r\n") }),
    null,
  );
});

test("each way a record is not the one signed is its own refusal", () => {
  const cases = [
    [{ fileText: null }, "record_not_found"],
    [{ fileText: "not json" }, "record_invalid"],
    [
      { fileText: `${JSON.stringify({ ...record, configSnapshotDigest: "b".repeat(64), stagingConfigSnapshotDigest: undefined })}\n` },
      "record_invalid",
    ],
    [
      { fileText: `${JSON.stringify({ ...record, conditions: { ...record.conditions, c4: "fail" } })}\n` },
      "record_invalid",
    ],
    [{ recordId: "2026-10-02__another" }, "record_id_mismatch"],
    [{ recordDigest: "c".repeat(64) }, "record_digest_mismatch"],
  ];
  for (const [override, code] of cases) {
    const input = { recordId: record.recordId, recordDigest, fileText, ...override };
    assert.equal(refusalCode(input), code, JSON.stringify(override).slice(0, 80));
  }

  const staleText = `${JSON.stringify({ ...record, pipelineFingerprint: "f".repeat(64) }, null, 2)}\n`;
  assert.equal(
    refusalCode({
      recordId: record.recordId,
      recordDigest: digestMarketingWebhookVerificationRecord(staleText),
      fileText: staleText,
    }),
    "record_pipeline_stale",
  );
});

test("a record id cannot name a path outside the record directory", () => {
  assert.equal(
    marketingWebhookVerificationRecordPath(record.recordId),
    "docs/ops/marketing-webhook-verification-records/2026-10-02__zernio-shadow.json",
  );
  for (const id of ["../secrets", "2026-10-02__../x", "2026-10-02__A", "2026-10-02__a/b", ""]) {
    assert.throws(
      () => marketingWebhookVerificationRecordPath(id),
      (error) => error instanceof MarketingWebhookVerificationRefusedError && error.code === "record_id_invalid",
      id,
    );
  }
});
