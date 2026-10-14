// The production configuration generation (S2 plan, S2f; S1 r7 amendment 1).

import assert from "node:assert/strict";
import test from "node:test";

import { MARKETING_WEBHOOK_PIPELINE_FINGERPRINT } from "@/lib/marketingAutomationAccess";
import { marketingWebhookStagingConfigSnapshotDigest } from "@/lib/marketingWebhookCore";
import {
  marketingWebhookProductionConfigRefusals,
  marketingWebhookProductionConfigSnapshotDigest,
  nextMarketingWebhookProductionConfigGeneration,
  readMarketingWebhookProductionConfig,
  serializeMarketingWebhookProductionConfig,
  type MarketingWebhookProductionConfigAuditEvidence,
  type MarketingWebhookProductionConfigCheck,
  type MarketingWebhookProductionConfigGeneration,
} from "@/lib/marketingWebhookProductionConfig";

const RECORD_ID = "2026-10-14__zernio-youtube-platform-published-main";
const ENV = {
  APP_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
  TOMVERSE_DEPLOY_ENV: "production",
  ZERNIO_API_KEY: "zernio-key-for-tests",
  ZERNIO_WEBHOOK_SECRET: "whsec-for-tests",
};
const CHANNELS = [
  { id: "chn-youtube", externalAccountRef: "acct-youtube" },
  { id: "chn-linkedin", externalAccountRef: "acct-linkedin" },
];
const LIVE_DIGEST = marketingWebhookProductionConfigSnapshotDigest(ENV, "false", CHANNELS);

const signed = (
  overrides: Partial<MarketingWebhookProductionConfigGeneration> = {},
): MarketingWebhookProductionConfigGeneration => ({
  generation: 3,
  recordId: RECORD_ID,
  environment: "production",
  deployCommitSha: "a".repeat(40),
  pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  productionConfigSnapshotDigest: LIVE_DIGEST,
  signatureAuditLogId: "audit-row-1",
  ...overrides,
});

const evidenceFor = (
  value: MarketingWebhookProductionConfigGeneration,
  overrides: Partial<MarketingWebhookProductionConfigAuditEvidence> = {},
): MarketingWebhookProductionConfigAuditEvidence => ({
  auditLogId: value.signatureAuditLogId,
  verified: true,
  generation: value.generation,
  recordId: value.recordId,
  deployCommitSha: value.deployCommitSha,
  pipelineFingerprint: value.pipelineFingerprint,
  productionConfigSnapshotDigest: value.productionConfigSnapshotDigest,
  ...overrides,
});

const check = (
  overrides: Partial<MarketingWebhookProductionConfigCheck> = {},
): MarketingWebhookProductionConfigCheck => {
  const value = signed();
  return {
    stored: { ok: true, value: { status: "valid", value } },
    audit: { ok: true, value: evidenceFor(value) },
    liveEnvironment: { ok: true, value: "production" },
    liveSnapshotDigest: { ok: true, value: LIVE_DIGEST },
    recordId: RECORD_ID,
    ...overrides,
  };
};

test("a stored generation round-trips and is read as valid", () => {
  const text = serializeMarketingWebhookProductionConfig(signed());
  assert.deepEqual(readMarketingWebhookProductionConfig(text), { status: "valid", value: signed() });
  // The file canonicalization the verification record uses: BOM and CRLF.
  assert.equal(readMarketingWebhookProductionConfig(`﻿${text}\r\n`).status, "valid");
});

test("absent and invalid are different answers, and every field is strict", () => {
  assert.deepEqual(readMarketingWebhookProductionConfig(null), { status: "absent" });
  assert.deepEqual(readMarketingWebhookProductionConfig(undefined), { status: "absent" });
  for (const text of [
    "",
    "not json",
    "{}",
    JSON.stringify({ ...signed(), extra: true }),
    JSON.stringify({ ...signed(), environment: "staging" }),
    JSON.stringify({ ...signed(), generation: 0 }),
    JSON.stringify({ ...signed(), generation: 1.5 }),
    JSON.stringify({ ...signed(), deployCommitSha: "A".repeat(40) }),
    JSON.stringify({ ...signed(), pipelineFingerprint: "f".repeat(63) }),
    JSON.stringify({ ...signed(), recordId: "not-a-record-id" }),
    JSON.stringify({ ...signed(), signatureAuditLogId: " " }),
  ]) {
    assert.deepEqual(readMarketingWebhookProductionConfig(text), { status: "invalid" }, text);
  }
});

test("the next generation is OLD+1, starts at 1, and refuses what it cannot see", () => {
  assert.equal(nextMarketingWebhookProductionConfigGeneration({ ok: true, value: { status: "absent" } }), 1);
  assert.equal(
    nextMarketingWebhookProductionConfigGeneration({
      ok: true,
      value: { status: "valid", value: signed({ generation: 7 }) },
    }),
    8,
  );
  assert.equal(nextMarketingWebhookProductionConfigGeneration({ ok: true, value: { status: "invalid" } }), null);
  assert.equal(nextMarketingWebhookProductionConfigGeneration({ ok: false }), null);
  assert.equal(
    nextMarketingWebhookProductionConfigGeneration({
      ok: true,
      value: { status: "valid", value: signed({ generation: Number.MAX_SAFE_INTEGER }) },
    }),
    null,
  );
});

test("the production digest is never the staging digest, and moves with what it binds", () => {
  assert.notEqual(LIVE_DIGEST, marketingWebhookStagingConfigSnapshotDigest(ENV, "false", CHANNELS));
  // Channel order is not configuration.
  assert.equal(
    marketingWebhookProductionConfigSnapshotDigest(ENV, "false", [...CHANNELS].reverse()),
    LIVE_DIGEST,
  );
  const moved = [
    marketingWebhookProductionConfigSnapshotDigest({ ...ENV, ZERNIO_WEBHOOK_SECRET: "rotated" }, "false", CHANNELS),
    marketingWebhookProductionConfigSnapshotDigest({ ...ENV, ZERNIO_API_KEY: undefined }, "false", CHANNELS),
    marketingWebhookProductionConfigSnapshotDigest({ ...ENV, TOMVERSE_DEPLOY_ENV: "staging" }, "false", CHANNELS),
    marketingWebhookProductionConfigSnapshotDigest(ENV, "true", CHANNELS),
    marketingWebhookProductionConfigSnapshotDigest(ENV, null, CHANNELS),
    marketingWebhookProductionConfigSnapshotDigest(ENV, "false", [
      CHANNELS[0],
      { id: "chn-linkedin", externalAccountRef: "another-account" },
    ]),
    marketingWebhookProductionConfigSnapshotDigest(ENV, "false", CHANNELS.slice(1)),
  ];
  for (const digest of moved) assert.notEqual(digest, LIVE_DIGEST);
  assert.equal(new Set(moved).size, moved.length);
  // An undeclared variable is not part of the slice.
  assert.equal(
    marketingWebhookProductionConfigSnapshotDigest({ ...ENV, UNRELATED: "x" }, "false", CHANNELS),
    LIVE_DIGEST,
  );
});

test("a signed generation that still matches everything binds", () => {
  assert.deepEqual(marketingWebhookProductionConfigRefusals(check()), []);
});

test("a deploy that keeps the fingerprint keeps the signature", () => {
  const value = signed({ deployCommitSha: "b".repeat(40) });
  assert.deepEqual(
    marketingWebhookProductionConfigRefusals(
      check({
        stored: { ok: true, value: { status: "valid", value } },
        audit: { ok: true, value: evidenceFor(value) },
      }),
    ),
    [],
  );
});

test("each way the signature stops binding is named", () => {
  const cases: Array<[Partial<MarketingWebhookProductionConfigCheck>, string[]]> = [
    [{ liveEnvironment: { ok: true, value: "staging" } }, ["production_config_not_production"]],
    [{ liveEnvironment: { ok: false } }, ["production_config_not_production"]],
    [{ recordId: "2026-10-15__another-record" }, ["production_config_record_mismatch"]],
    [{ recordId: null }, ["production_config_record_mismatch"]],
    [{ liveSnapshotDigest: { ok: true, value: "0".repeat(64) } }, ["production_config_snapshot_mismatch"]],
    [{ liveSnapshotDigest: { ok: false } }, ["production_config_snapshot_mismatch"]],
    [{ audit: { ok: false } }, ["production_config_audit_unreadable"]],
    [
      { stored: { ok: true, value: { status: "absent" } } },
      ["production_config_absent", "production_config_audit_invalid"],
    ],
    [
      { stored: { ok: true, value: { status: "invalid" } } },
      ["production_config_invalid", "production_config_audit_invalid"],
    ],
    [{ stored: { ok: false } }, ["production_config_unreadable", "production_config_audit_invalid"]],
  ];
  for (const [overrides, expected] of cases) {
    assert.deepEqual(marketingWebhookProductionConfigRefusals(check(overrides)), expected, JSON.stringify(overrides));
  }
});

test("a fingerprint that moved since signing is stale", () => {
  const value = signed({ pipelineFingerprint: "e".repeat(64) });
  assert.deepEqual(
    marketingWebhookProductionConfigRefusals(
      check({
        stored: { ok: true, value: { status: "valid", value } },
        audit: { ok: true, value: evidenceFor(value) },
      }),
    ),
    ["production_config_fingerprint_stale"],
  );
});

test("the audit row must bind every signed field, and be verified", () => {
  const value = signed();
  const audits: Array<Partial<MarketingWebhookProductionConfigAuditEvidence>> = [
    { verified: false },
    { auditLogId: "audit-row-2" },
    { generation: 2 },
    { recordId: "2026-10-15__another-record" },
    { deployCommitSha: "c".repeat(40) },
    { pipelineFingerprint: "d".repeat(64) },
    { productionConfigSnapshotDigest: "1".repeat(64) },
  ];
  for (const overrides of audits) {
    assert.deepEqual(
      marketingWebhookProductionConfigRefusals(check({ audit: { ok: true, value: evidenceFor(value, overrides) } })),
      ["production_config_audit_invalid"],
      JSON.stringify(overrides),
    );
  }
});
