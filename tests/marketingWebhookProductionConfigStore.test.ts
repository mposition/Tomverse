// Signing the production webhook configuration generation (S2 plan, S2f).
//
// A fake transaction that keeps AppSetting rows in a map and applies the same
// conditional writes Prisma would, and a fake audit verifier that answers from
// a table: what is under test is which value is written, when the write is
// refused, and that every refusal comes before the write.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  MARKETING_WEBHOOK_SHADOW_KEY,
  digestMarketingWebhookVerificationRecord,
} from "@/lib/marketingAutomationAccess";
import type { MarketingAuditRequirement, MarketingAuditVerdict } from "@/lib/marketingAuditEvidence";
import type { MarketingTransaction } from "@/lib/marketingStore";
import {
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
  marketingWebhookProductionConfigSnapshotDigest,
  readMarketingWebhookProductionConfig,
  serializeMarketingWebhookProductionConfig,
} from "@/lib/marketingWebhookProductionConfig";
import {
  MarketingWebhookProductionConfigRefusedError,
  readMarketingWebhookProductionConfigLive,
  signMarketingWebhookProductionConfig,
  type MarketingWebhookProductionConfigSignRequest,
} from "@/lib/marketingWebhookProductionConfigStore";

const RECORD_ID = "2026-10-14__zernio-youtube-platform-published-main";
const COMMIT = "c".repeat(40);
const ENV = {
  APP_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_GIT_COMMIT_SHA: COMMIT.toUpperCase(),
  ZERNIO_API_KEY: "zernio-key-for-tests",
  ZERNIO_WEBHOOK_SECRET: "whsec-for-tests",
};
const CHANNELS = [{ id: "chn-youtube", externalAccountRef: "acct-youtube" }];

const recordText = (overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      recordId: RECORD_ID,
      executor: "claude-staging-session",
      stagingCommitSha: "a".repeat(40),
      observedScope: [{ eventType: "post.platform.published", channelId: "chn-youtube" }],
      conditions: { c1: "pass", c2: "pass", c3: "pass", c4: "pass", c5: "pass" },
      evidenceRefs: ["zernio-webhook-log:e:2026-10-14T00:00:00.000Z:200:recorded"],
      pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
      stagingConfigSnapshotDigest: "5".repeat(64),
      ...overrides,
    },
    null,
    2,
  )}\n`;
const RECORD = recordText();
const RECORD_DIGEST = digestMarketingWebhookVerificationRecord(RECORD);
const LIVE_DIGEST = marketingWebhookProductionConfigSnapshotDigest(ENV, null, CHANNELS);

const fakeTx = (rows: Record<string, string> = {}) => {
  const settings = new Map(Object.entries(rows));
  const tx = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { value: settings.get(where.key)! } : null,
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (settings.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        settings.set(data.key, data.value);
        return data;
      },
      updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
        if (settings.get(where.key) !== where.value) return { count: 0 };
        settings.set(where.key, data.value);
        return { count: 1 };
      },
    },
    marketingChannel: {
      findMany: async () => CHANNELS,
    },
  };
  return { tx: tx as unknown as MarketingTransaction, settings };
};

/** Every requirement verifies unless a test says which action does not. */
const verifier = (refuseAction?: string) => {
  const seen: MarketingAuditRequirement[] = [];
  const verify = async (
    _tx: MarketingTransaction,
    requirement: MarketingAuditRequirement,
  ): Promise<MarketingAuditVerdict> => {
    seen.push(requirement);
    return requirement.action === refuseAction
      ? { ok: false, problem: "entry_unhashed" }
      : { ok: true, createdAt: new Date() };
  };
  return { verify, seen };
};

const request = (
  overrides: Partial<MarketingWebhookProductionConfigSignRequest> = {},
): MarketingWebhookProductionConfigSignRequest => ({
  generation: 1,
  recordId: RECORD_ID,
  recordDigest: RECORD_DIGEST,
  verificationSignatureAuditLogId: "audit-record-signature",
  deployCommitSha: COMMIT,
  pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  productionConfigSnapshotDigest: LIVE_DIGEST,
  ...overrides,
});

const sign = (
  tx: MarketingTransaction,
  body: MarketingWebhookProductionConfigSignRequest,
  options: { env?: Record<string, string | undefined>; file?: string | null; refuseAction?: string } = {},
) => {
  const { verify, seen } = verifier(options.refuseAction);
  const promise = signMarketingWebhookProductionConfig(tx, body, "audit-this-signature", {
    env: options.env ?? ENV,
    readRecordFile: async () => (options.file === undefined ? RECORD : options.file),
    verifyAudit: verify,
  });
  return { promise, seen };
};

const refusedWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof MarketingWebhookProductionConfigRefusedError && error.code === code,
    code,
  );
};

test("an unlabelled deployment reads as unlabelled, not as production", async () => {
  const { tx } = fakeTx();
  const live = await readMarketingWebhookProductionConfigLive(tx, {
    ...ENV,
    APP_ENV: undefined,
    RAILWAY_ENVIRONMENT_NAME: undefined,
    NODE_ENV: "production",
  });
  assert.equal(live.environment, "unlabelled");
  // Railway names the environment even when APP_ENV is unset.
  const railwayOnly = await readMarketingWebhookProductionConfigLive(tx, { ...ENV, APP_ENV: undefined });
  assert.equal(railwayOnly.environment, "production");
});

test("the live read shows what a signature would bind", async () => {
  const { tx } = fakeTx();
  const live = await readMarketingWebhookProductionConfigLive(tx, ENV);
  assert.equal(live.environment, "production");
  assert.equal(live.deployCommitSha, COMMIT);
  assert.equal(live.pipelineFingerprint, MARKETING_WEBHOOK_PIPELINE_FINGERPRINT);
  assert.equal(live.productionConfigSnapshotDigest, LIVE_DIGEST);
  assert.deepEqual(live.stored, { status: "absent" });
  assert.equal(live.nextGeneration, 1);
});

test("a first signature writes generation 1 bound to this request's audit row", async () => {
  const { tx, settings } = fakeTx();
  const { promise, seen } = sign(tx, request());
  const value = await promise;
  assert.deepEqual(value, {
    generation: 1,
    recordId: RECORD_ID,
    environment: "production",
    deployCommitSha: COMMIT,
    pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
    productionConfigSnapshotDigest: LIVE_DIGEST,
    signatureAuditLogId: "audit-this-signature",
  });
  assert.deepEqual(readMarketingWebhookProductionConfig(settings.get(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY)), {
    status: "valid",
    value,
  });
  // The record's signature first, then this request's own row, read back last.
  assert.deepEqual(
    seen.map((requirement) => requirement.action),
    ["marketing_webhook.verification_signed", MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION],
  );
  assert.deepEqual(seen[1], {
    auditLogId: "audit-this-signature",
    action: MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
    targetId: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
    metadata: {
      generation: 1,
      recordId: RECORD_ID,
      deployCommitSha: COMMIT,
      pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
      productionConfigSnapshotDigest: LIVE_DIGEST,
      verificationSignatureAuditLogId: "audit-record-signature",
    },
  });
});

test("a later signature is OLD+1 and replaces exactly the value it read", async () => {
  const previous = serializeMarketingWebhookProductionConfig({
    generation: 4,
    recordId: RECORD_ID,
    environment: "production",
    deployCommitSha: "d".repeat(40),
    pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
    productionConfigSnapshotDigest: "9".repeat(64),
    signatureAuditLogId: "audit-older",
  });
  const { tx, settings } = fakeTx({ [MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY]: previous });
  await refusedWith(sign(tx, request({ generation: 4 })).promise, "production_config_conflict");
  await refusedWith(sign(tx, request({ generation: 6 })).promise, "production_config_conflict");
  assert.equal(settings.get(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY), previous);
  const value = await sign(tx, request({ generation: 5 })).promise;
  assert.equal(value.generation, 5);
});

test("a stored value this build refuses is never signed over", async () => {
  const { tx, settings } = fakeTx({ [MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY]: "{\"generation\":1}" });
  await refusedWith(sign(tx, request()).promise, "production_config_unreadable");
  assert.equal(settings.get(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY), "{\"generation\":1}");
});

test("anywhere but production refuses before reading anything", async () => {
  for (const env of [
    { ...ENV, APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "staging" },
    { ...ENV, APP_ENV: "dev", RAILWAY_ENVIRONMENT_NAME: "dev" },
    // A production build with no label: resolveDeploymentEnvironment() would
    // call it production through NODE_ENV, and a signature must not.
    { ...ENV, APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: undefined, NODE_ENV: "production" },
    { ...ENV, APP_ENV: "prod", RAILWAY_ENVIRONMENT_NAME: "live", NODE_ENV: "production" },
    { ...ENV, APP_ENV: "", RAILWAY_ENVIRONMENT_NAME: " ", NODE_ENV: "production" },
  ]) {
    const { tx, settings } = fakeTx();
    const { promise } = sign(tx, request(), { env, file: null });
    await refusedWith(promise, "environment_not_production");
    assert.equal(settings.size, 0);
  }
});

test("each value the screen showed is checked again, and a moved one refuses", async () => {
  const cases: Array<[Partial<MarketingWebhookProductionConfigSignRequest>, string, Record<string, unknown>?]> = [
    [{ pipelineFingerprint: "f".repeat(64) }, "pipeline_fingerprint_changed"],
    [{ deployCommitSha: "e".repeat(40) }, "deploy_commit_changed"],
    [{ productionConfigSnapshotDigest: "0".repeat(64) }, "config_snapshot_changed"],
    [{ recordDigest: "1".repeat(64) }, "record_digest_mismatch"],
  ];
  for (const [overrides, code] of cases) {
    const { tx, settings } = fakeTx();
    await refusedWith(sign(tx, request(overrides)).promise, code);
    assert.equal(settings.has(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY), false, code);
  }
});

test("a configuration change between the screen and the signature refuses", async () => {
  const { tx, settings } = fakeTx({ [MARKETING_WEBHOOK_SHADOW_KEY]: "true" });
  await refusedWith(sign(tx, request()).promise, "config_snapshot_changed");
  assert.equal(settings.has(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY), false);
});

test("a deployment that does not report its commit cannot be signed", async () => {
  const { tx } = fakeTx();
  await refusedWith(
    sign(tx, request(), { env: { ...ENV, RAILWAY_GIT_COMMIT_SHA: undefined } }).promise,
    "deploy_commit_unknown",
  );
});

test("the record must be in the tree, strict, this build's, and signed", async () => {
  const cases: Array<[string | null, string]> = [
    [null, "record_not_found"],
    ["not json", "record_invalid"],
    [recordText({ recordId: "2026-10-14__another" }), "record_invalid"],
    [recordText({ extra: true }), "record_invalid"],
  ];
  for (const [file, code] of cases) {
    const { tx } = fakeTx();
    await refusedWith(sign(tx, request(), { file }).promise, code);
  }
  const stale = recordText({ pipelineFingerprint: "e".repeat(64) });
  const { tx } = fakeTx();
  await refusedWith(
    sign(tx, request({ recordDigest: digestMarketingWebhookVerificationRecord(stale) }), { file: stale }).promise,
    "record_pipeline_stale",
  );
  const unsigned = fakeTx();
  await refusedWith(
    sign(unsigned.tx, request(), { refuseAction: "marketing_webhook.verification_signed" }).promise,
    "record_signature_unverified",
  );
  assert.equal(unsigned.settings.has(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY), false);
});

test("an own audit row that does not verify refuses the signature it would have made", async () => {
  // The write happened inside the transaction; the refusal is what rolls it back.
  const { tx } = fakeTx();
  await refusedWith(
    sign(tx, request(), { refuseAction: MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION }).promise,
    "signature_audit_unverifiable",
  );
});

test("a racing first signature loses on the key, not silently", async () => {
  const { tx, settings } = fakeTx();
  // The fake create, wrapped so the other request writes the key first.
  const appSetting = tx.appSetting as unknown as { create: (args: unknown) => Promise<unknown> };
  const original = appSetting.create;
  appSetting.create = async (args) => {
    settings.set(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY, "written by the other request");
    return original(args);
  };
  await refusedWith(sign(tx, request()).promise, "production_config_conflict");
});
