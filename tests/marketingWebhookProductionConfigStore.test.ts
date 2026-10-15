// Signing the production webhook configuration generation (S2 plan, S2f).
//
// A fake transaction that keeps AppSetting rows in a map and applies the same
// conditional writes Prisma would, and a fake audit verifier that answers from
// a table: what is under test is which value is written, when the write is
// refused, and that every refusal comes before the write.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_WEBHOOK_APPLY_SCOPE_KEY,
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  MARKETING_WEBHOOK_SHADOW_KEY,
  digestMarketingWebhookVerificationRecord,
} from "@/lib/marketingAutomationAccess";
import type {
  MarketingAuditReader,
  MarketingAuditRequirement,
  MarketingAuditVerdict,
} from "@/lib/marketingAuditEvidence";
import type { MarketingTransaction } from "@/lib/marketingStore";
import {
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
  marketingWebhookProductionConfigSnapshotDigest,
  marketingWebhookStoredValueDigest,
  readMarketingWebhookProductionApplyScope,
  readMarketingWebhookProductionConfig,
  serializeMarketingWebhookProductionApplyScope,
  serializeMarketingWebhookProductionConfig,
} from "@/lib/marketingWebhookProductionConfig";
import {
  MarketingWebhookProductionConfigRefusedError,
  readMarketingWebhookProductionConfigLive,
  readMarketingWebhookProductionRecord,
  setMarketingWebhookProductionApplyScope,
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

/**
 * The audit rows each fake transaction holds: id -> the metadata the route
 * bound. A requirement verifies as the real verifier would -- every metadata
 * key it names must be on the row with exactly that value -- unless a test
 * says which action does not verify at all. A row nothing recorded verifies
 * (the record-signature row, which this suite does not write).
 */
const ledgers = new WeakMap<object, Map<string, Record<string, unknown>>>();
const ledgerOf = (tx: MarketingTransaction) => {
  let ledger = ledgers.get(tx);
  if (!ledger) ledgers.set(tx, (ledger = new Map()));
  return ledger;
};

const verifier = (refuseAction?: string) => {
  const seen: MarketingAuditRequirement[] = [];
  const verify = async (
    tx: MarketingTransaction,
    requirement: MarketingAuditRequirement,
  ): Promise<MarketingAuditVerdict> => {
    seen.push(requirement);
    if (requirement.action === refuseAction) return { ok: false, problem: "entry_unhashed" };
    const row = ledgerOf(tx).get(requirement.auditLogId);
    if (
      row &&
      Object.entries(requirement.metadata ?? {}).some(([key, value]) => row[key] !== value)
    ) {
      return { ok: false, problem: "metadata_mismatch" };
    }
    return { ok: true, createdAt: new Date() };
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
  // What the route's audit row binds, written before the store runs.
  ledgerOf(tx).set("audit-this-signature", { ...body });
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
      recordDigest: RECORD_DIGEST,
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

// ---------------------------------------------------------------------------
// The apply scope
// ---------------------------------------------------------------------------

const SCOPE = [{ eventType: "post.platform.published", channelId: "chn-youtube" }];

/** A store holding a production generation signed against the live configuration. */
const signedStore = async (extra: Record<string, string> = {}) => {
  const { tx, settings } = fakeTx(extra);
  await sign(tx, request()).promise;
  return { tx, settings };
};

const setScope = (
  tx: MarketingTransaction,
  body: Partial<Parameters<typeof setMarketingWebhookProductionApplyScope>[1]> = {},
  options: { env?: Record<string, string | undefined>; file?: string | null; refuseAction?: string } = {},
) => {
  const { verify } = verifier(options.refuseAction);
  return setMarketingWebhookProductionApplyScope(
    tx,
    {
      recordId: RECORD_ID,
      productionConfigGeneration: 1,
      scope: SCOPE,
      expectedStoredDigest: "absent",
      ...body,
    },
    {
      env: options.env ?? ENV,
      readRecordFile: async () => (options.file === undefined ? RECORD : options.file),
      verifyAudit: verify,
    },
  );
};

test("a scope of observed pairs under the signed generation is stored", async () => {
  const { tx, settings } = await signedStore();
  const value = await setScope(tx);
  assert.deepEqual(value, { recordId: RECORD_ID, productionConfigGeneration: 1, scope: SCOPE });
  const live = await readMarketingWebhookProductionConfigLive(tx, ENV);
  assert.deepEqual(live.applyScope.status, "valid");
  assert.equal(live.applyScope.storedDigest, marketingWebhookStoredValueDigest(settings.get(MARKETING_WEBHOOK_APPLY_SCOPE_KEY)));
});

test("a pair the record never observed is refused", async () => {
  const { tx, settings } = await signedStore();
  await refusedWith(
    setScope(tx, { scope: [...SCOPE, { eventType: "post.failed", channelId: "chn-youtube" }] }),
    "scope_not_observed",
  );
  assert.equal(settings.has(MARKETING_WEBHOOK_APPLY_SCOPE_KEY), false);
});

test("a scope needs the generation it names to be the signed one, still binding", async () => {
  const { tx } = await signedStore();
  await refusedWith(setScope(tx, { productionConfigGeneration: 2 }), "production_config_mismatch");
  await refusedWith(
    setScope(tx, {}, { refuseAction: MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION }),
    "production_config_not_binding",
  );
  // A configuration change after signing stops a scope being set over it.
  await tx.appSetting.create({ data: { key: MARKETING_WEBHOOK_SHADOW_KEY, value: "false" } });
  await refusedWith(setScope(tx), "production_config_not_binding");
  const unsigned = fakeTx();
  await refusedWith(setScope(unsigned.tx), "production_config_mismatch");
});

test("an empty scope stops applying and needs nothing else", async () => {
  // No signed generation, no record: stopping must still work.
  const { tx, settings } = fakeTx();
  const value = await setScope(tx, { scope: [] }, { file: null, refuseAction: MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION });
  assert.deepEqual(value.scope, []);
  assert.equal(readMarketingWebhookProductionApplyScope(settings.get(MARKETING_WEBHOOK_APPLY_SCOPE_KEY)).status, "valid");
  // ...but only in production.
  await refusedWith(
    setScope(fakeTx().tx, { scope: [] }, { env: { ...ENV, APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "staging" } }),
    "environment_not_production",
  );
});

test("the scope is compare-and-set on the exact stored bytes", async () => {
  const { tx, settings } = await signedStore();
  await setScope(tx);
  const stored = settings.get(MARKETING_WEBHOOK_APPLY_SCOPE_KEY);
  await refusedWith(setScope(tx, { scope: [] }), "apply_scope_conflict");
  await refusedWith(setScope(tx, { expectedStoredDigest: marketingWebhookStoredValueDigest(stored) }), "apply_scope_noop");
  await setScope(tx, { scope: [], expectedStoredDigest: marketingWebhookStoredValueDigest(stored) });
  assert.deepEqual(readMarketingWebhookProductionApplyScope(settings.get(MARKETING_WEBHOOK_APPLY_SCOPE_KEY)), {
    status: "valid",
    value: { recordId: RECORD_ID, productionConfigGeneration: 1, scope: [] },
  });
});

test("duplicate pairs are not a scope", async () => {
  const { tx } = await signedStore();
  await refusedWith(setScope(tx, { scope: [...SCOPE, ...SCOPE] }), "apply_scope_invalid");
});

test("the same set of pairs is the same stored bytes, in any order", () => {
  const a = { eventType: "post.platform.published", channelId: "chn-a" };
  const b = { eventType: "post.platform.published", channelId: "chn-b" };
  const base = { recordId: RECORD_ID, productionConfigGeneration: 1 };
  assert.equal(
    serializeMarketingWebhookProductionApplyScope({ ...base, scope: [a, b] }),
    serializeMarketingWebhookProductionApplyScope({ ...base, scope: [b, a] }),
  );
});

test("a record rewritten under the same id cannot stretch the old signature to new pairs", async () => {
  const { tx, settings } = await signedStore();
  // Same id, one more observed pair, redeployed with fingerprint and live
  // configuration unchanged.
  const rewritten = recordText({
    observedScope: [
      { eventType: "post.platform.published", channelId: "chn-youtube" },
      { eventType: "post.failed", channelId: "chn-youtube" },
    ],
  });
  for (const scope of [SCOPE, [{ eventType: "post.failed", channelId: "chn-youtube" }]]) {
    await refusedWith(setScope(tx, { scope }, { file: rewritten }), "production_config_not_binding");
  }
  assert.equal(settings.has(MARKETING_WEBHOOK_APPLY_SCOPE_KEY), false);
  // The bytes it was signed over still work.
  await setScope(tx);
});

// ---------------------------------------------------------------------------
// The record lookup the production screen uses before signing
// ---------------------------------------------------------------------------

/** Rows as [id, the recordDigest their metadata names]; a bare id names RECORD_DIGEST. */
const auditDb = (rows: Array<string | [string, string]>) =>
  ({
    adminAuditLog: {
      findMany: async ({
        where,
        take,
      }: {
        where: { action: string; targetId: string; metadata: { path: string[]; equals: string } };
        take: number;
      }) =>
        rows
          .map((row) => (typeof row === "string" ? [row, RECORD_DIGEST] : row))
          .filter(
            ([, digest]) =>
              where.action === "marketing_webhook.verification_signed" &&
              where.targetId === RECORD_ID &&
              where.metadata.path.join(".") === "recordDigest" &&
              digest === where.metadata.equals,
          )
          .slice(0, take)
          .map(([id]) => ({ id })),
    },
  }) as unknown as MarketingAuditReader;

const lookup = (
  ids: Array<string | [string, string]>,
  options: { file?: string | null; verified?: (id: string, digest: unknown) => boolean } = {},
) =>
  readMarketingWebhookProductionRecord(auditDb(ids), RECORD_ID, {
    readRecordFile: async () => (options.file === undefined ? RECORD : options.file),
    verifyAudit: async (_tx, requirement) =>
      (options.verified ?? (() => true))(requirement.auditLogId, requirement.metadata?.recordDigest)
        ? { ok: true, createdAt: new Date() }
        : { ok: false, problem: "metadata_mismatch" },
  });

test("the record lookup names the newest verified signature of exactly these bytes", async () => {
  const view = await lookup(["audit-newest", "audit-older"], {
    verified: (id, digest) => id === "audit-older" && digest === RECORD_DIGEST,
  });
  assert.deepEqual(view, {
    recordId: RECORD_ID,
    status: "found",
    recordDigest: RECORD_DIGEST,
    pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
    observedScope: SCOPE,
    verificationSignatureAuditLogId: "audit-older",
  });
});

test("a record nobody signed, or that is not in the tree, offers nothing to sign over", async () => {
  assert.equal((await lookup([], {})).verificationSignatureAuditLogId, null);
  assert.equal((await lookup(["audit-1"], { verified: () => false })).verificationSignatureAuditLogId, null);
  assert.equal((await lookup(["audit-1"], { file: null })).status, "not_found");
  assert.equal((await lookup(["audit-1"], { file: "not json" })).status, "invalid");
  assert.equal((await lookup(["audit-1"], { file: recordText({ recordId: "2026-10-14__other" }) })).status, "invalid");
});

test("signatures of other bytes under the same id cannot crowd out the one that counts", async () => {
  const others: Array<[string, string]> = Array.from({ length: 12 }, (_, index) => [`audit-old-${index}`, "0".repeat(64)]);
  const view = await lookup([...others, "audit-current"]);
  assert.equal(view.verificationSignatureAuditLogId, "audit-current");
});
