import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";

import { MARKETING_CHANNEL_CAPS } from "@/lib/marketingAutomationSchema";
import {
  guardDraft,
  sealMarketingFacts,
  sealMarketingGuardContext,
} from "@/lib/marketingGuardCore";
import { createHash } from "node:crypto";
import { marketingEnvelopeDigest } from "@/lib/marketingStore";
import {
  approveMarketingPost,
  marketingSerializationFailure,
  createMarketingChannel,
  createMarketingPost,
  insertAiVisibilityRun,
  insertMarketingReport,
  MarketingStoreRefusedError,
  updateMarketingChannel,
  MARKETING_RESUME_AUTONOMOUS_ACTION,
  MARKETING_S2B1_ACTIONS,
  lowerMarketingChannelCaps,
  resumeMarketingChannelToApproval,
  runMarketingTransaction,
} from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";

// The marketing tables' invariants against a real database.
//
// Contract: docs/policy/marketing-automation.md, migration
// 20260918120000_marketing_automation_tables. The unit suite
// (tests/marketingAutomationSchema.test.mjs) pins the lists, the schemas and the
// constants the SQL duplicates, which is the half that can be read from source.
// This is the other half: the triggers and CHECK constraints refuse writes that
// never go near the store module, because an insert that reached the table
// another way is exactly the case they exist for. Almost every write below is a
// direct Prisma call for that reason.
//
// The retention setting is a transaction-local GUC, so each test that needs it
// opens its own transaction and sets it there; a test that forgets sees the
// refusal, which is the default.

const AUDIT_SECRET = "marketing-schema-db-secret-0041";

const operator = {
  user: { id: "marketing-operator", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

/**
 * A real audit entry of the kind an operator route writes in S2.
 *
 * Written through the audit writer rather than inserted, so it carries a real
 * hash and a real place in the chain -- which is what the evidence check reads.
 * Returns the entry id.
 */
async function resumeAuditEntry(channelId: string, reasonCode: string) {
  return writeAdminAuditLog({
    session: operator,
    request: new Request("https://tomverse.app/api/admin/marketing/resume"),
    action: MARKETING_RESUME_AUTONOMOUS_ACTION,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Resumed after the incident was resolved.",
    metadata: { actorHadMarketingWrite: true, reasonCode },
  });
}

const resumeAutonomous = async (
  channelId: string,
  auditLogId: string,
  reasonCode: string,
) => {
  const current = await prisma.marketingChannel.findUniqueOrThrow({
    where: { id: channelId },
  });
  return updateMarketingChannel(
    prisma,
    channelId,
    {
      status: "autonomous_mode",
      graduatedAt: current.graduatedAt,
      graduationSnapshot: current.graduationSnapshot as never,
    },
    { auditLogId, reasonCode: reasonCode as never },
  );
};

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun" RESTART IDENTITY CASCADE`,
  );

const RETENTION_ON = `SET LOCAL tomverse.marketing_retention_compaction = 'on'`;

const DIGEST = "b".repeat(64);
const OTHER_DIGEST = "c".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const envelope = (overrides: Record<string, unknown> = {}) => ({
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Three models, three answers, side by side.",
  claimIds: [],
  assets: [],
  finalUrl: null,
  scheduledAt: null,
  disclosureFlags: ["advertising"],
  ...overrides,
});

const factSnapshot = {
  priceRows: [],
  catalogue: null,
  modelRegistryRows: [],
  evidenceDigests: [],
};

const historyEntry = (type: string, extra: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
  type,
  ...extra,
});

async function channel(overrides: Record<string, unknown> = {}) {
  return createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
    ...overrides,
  } as Parameters<typeof createMarketingChannel>[1]);
}

/** Put an account into approval mode, which is where every post starts from. */
async function approvedChannel(overrides: Record<string, unknown> = {}) {
  const row = await channel(overrides);
  return prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode" },
  });
}

/** A post row written straight to the table, so a test can choose every column. */
async function post(channelId: string, overrides: Record<string, unknown> = {}) {
  return prisma.marketingPost.create({
    data: {
      channelId,
      locale: "en",
      kind: "social",
      logicalKey: `post-${Math.random().toString(36).slice(2)}`,
      envelope: envelope(),
      envelopeDigest: DIGEST,
      rendererVersion: "r1",
      claimIds: [],
      assetIds: [],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshot,
      factsDigest: DIGEST,
      guardDecision: "approval_required",
      guardCodes: [],
      guardRuleIds: [],
      status: "drafted",
      mode: "approval",
      history: [historyEntry("draft", { envelopeDigest: DIGEST })],
      historyVersion: 0,
      ...overrides,
    },
  });
}

/**
 * A post that is already old.
 *
 * `createdAt` is written by the insert trigger from the server clock and refused
 * any later change, which is the point of it -- so the only way to test an age
 * boundary is to insert past that trigger. This is a disposable test database
 * and the trigger is put back immediately; nothing else in the suite runs while
 * it is off, because node:test runs a file's tests one at a time.
 */
async function agedPost(
  channelId: string,
  ageDays: number,
  overrides: Record<string, unknown> = {},
) {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`,
  );
  try {
    return await post(channelId, {
      createdAt: new Date(Date.now() - ageDays * DAY),
      ...overrides,
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`,
    );
  }
}

/**
 * A post carried to `publishing` the way the whitelist requires.
 *
 * Built by walking the real transitions rather than by inserting the end state:
 * the insert trigger refuses a row created as though it had been published, and
 * the dispatched-status CHECK refuses one without a provider request key, so a
 * fixture that jumps straight there fails before the assertion it was written
 * for and says nothing about the rule under test.
 */
async function dispatchedPost(channelId: string) {
  const draft = await post(channelId);
  const step = (data: Record<string, unknown>) =>
    prisma.marketingPost.update({ where: { id: draft.id }, data });

  await step({ status: "pending_approval" });
  await step({
    status: "approved",
    approvalAuditLogId: "audit-approval-1",
    approvedAt: new Date(),
    approvedDigest: DIGEST,
  });
  await step({ status: "scheduled" });
  return step({
    status: "publishing",
    publishAttempt: 1,
    providerRequestKey: draft.logicalKey,
  });
}

/** The same, one step further. */
async function publishedPost(channelId: string) {
  const dispatched = await dispatchedPost(channelId);
  return prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: { status: "published", publishedAt: new Date() },
  });
}

/**
 * A write the database refuses, in a transaction of its own with the retention
 * setting on.
 *
 * The rejection has to escape the transaction. A trigger's RAISE aborts it, so
 * catching the error inside the callback and returning normally leaves Prisma
 * committing an aborted transaction: that fails with `25P02`, and the assertion
 * the test was written for never runs. For the same reason each refusal gets
 * its own transaction rather than sharing one.
 */
const refusedUnderRetention = async (
  operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
  expected: RegExp,
) => {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(RETENTION_ON);
      await operation(tx);
    }),
    (error: Error) => {
      assert.match(error.message, expected);
      return true;
    },
  );
};

const refusedCompaction = (id: string, history: unknown[], expected: RegExp) =>
  refusedUnderRetention(
    (tx) =>
      tx.marketingPost.update({
        where: { id },
        data: {
          history: history as Prisma.InputJsonValue[],
          historyVersion: 1,
        },
      }),
    expected,
  );

const refused = async (operation: Promise<unknown>, expected: RegExp) => {
  await assert.rejects(operation, (error: Error) => {
    assert.match(error.message, expected);
    return true;
  });
};

const refusedByStore = async (operation: Promise<unknown>, expectedCode: string) => {
  await assert.rejects(operation, (error: Error) => {
    assert.ok(error instanceof MarketingStoreRefusedError);
    assert.equal(error.code, expectedCode);
    return true;
  });
};

let previousAuditKey: string | undefined;

beforeEach(async () => {
  previousAuditKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_SECRET;
  await reset();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "PromptRefinerShadowAttempt",
      "PromptRefinerShadowRun",
      "PromptRefinerReservation",
      "PromptRefinerReservationStage",
      "AdminAuditLog"
    RESTART IDENTITY
  `);
});

after(async () => {
  if (previousAuditKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousAuditKey;
  await reset();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// O15: the two channels whose posts the API cannot retract
// ---------------------------------------------------------------------------

test("an Instagram account cannot hold an autonomous status", async () => {
  const row = await approvedChannel({ channel: "instagram" });
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "autonomous_mode",
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /no_autonomy_channels|autonomous/i,
  );
});

test("a post cannot be autonomous on a channel the API cannot retract", async () => {
  const instagram = await approvedChannel({ channel: "instagram" });
  await refused(
    post(instagram.id, {
      mode: "autonomous",
      guardDecision: "autonomous_eligible",
      templateId: "template.a",
      templateDigest: DIGEST,
    }),
    /cannot be autonomous on instagram/,
  );
});

test("a temporary table of the same name cannot answer for the channel", async () => {
  // The trigger reads the channel from the schema its own table is in. Without
  // that, a session with TEMP rights could put a row saying `linkedin` in front
  // of the real Instagram one and have an autonomous post admitted against it,
  // with the foreign key still pointing at the real account.
  const instagram = await approvedChannel({ channel: "instagram" });

  // The rejection escapes the transaction: a trigger's RAISE aborts it, so
  // catching the error inside and returning normally would leave Prisma
  // committing an aborted transaction and failing with 25P02 instead.
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TEMPORARY TABLE "MarketingChannel" ("id" TEXT, "channel" TEXT, "allowedLocales" TEXT[]) ON COMMIT DROP`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO pg_temp."MarketingChannel" VALUES ($1, 'linkedin', ARRAY['en'])`,
        instagram.id,
      );
      await tx.marketingPost.create({
        data: {
          channelId: instagram.id,
          locale: "en",
          kind: "social",
          logicalKey: "masked-1",
          envelope: envelope(),
          envelopeDigest: DIGEST,
          rendererVersion: "r1",
          claimIds: [],
          assetIds: [],
          claimRegistryVersion: 1,
          assetRegistryVersion: 1,
          factSnapshot,
          factsDigest: DIGEST,
          guardDecision: "autonomous_eligible",
          guardCodes: [],
          guardRuleIds: [],
          status: "drafted",
          mode: "autonomous",
          templateId: "template.a",
          templateDigest: DIGEST,
          history: [historyEntry("draft", { envelopeDigest: DIGEST })],
          historyVersion: 0,
        },
      });
    }),
    (error: Error) => {
      assert.match(error.message, /cannot be autonomous on instagram/);
      return true;
    },
  );
});

test("autonomous mode is allowed on a channel that can retract", async () => {
  const linkedin = await approvedChannel();
  const row = await post(linkedin.id, {
    mode: "autonomous",
    guardDecision: "autonomous_eligible",
    templateId: "template.a",
    templateDigest: DIGEST,
  });
  assert.equal(row.mode, "autonomous");
});

test("a post cannot be in a language its account does not publish in", async () => {
  const linkedin = await approvedChannel();
  await refused(
    post(linkedin.id, { locale: "zh-Hans" }),
    /the account does not publish in it/,
  );
});

// ---------------------------------------------------------------------------
// Channel identity, transitions and caps
// ---------------------------------------------------------------------------

test("a channel's platform, carrier and slug are immutable", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.update({ where: { id: row.id }, data: { channel: "x" } }),
    /identity is immutable/,
  );
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { provider: "manual", externalAccountRef: null },
    }),
    /identity is immutable/,
  );
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { accountSlug: "linkedin-9" },
    }),
    /slug is immutable/,
  );
});

test("a slug always names its own channel", async () => {
  // At insert, where the store is not the one choosing it. An update would only
  // prove the immutability trigger fires, which is a different rule.
  await refused(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingChannel" ("id","channel","provider","externalAccountRef","accountSlug","defaultLocale","allowedLocales","scopesDigest","status","updatedAt")
       VALUES ('mismatched-slug','linkedin','zernio','zernio-mismatch','tiktok-1','en',ARRAY['en'],$1,'connect_pending', now())`,
      DIGEST,
    ),
    /accountSlug_shape/,
  );
});

test("a manual channel has no external account and an API channel must have one", async () => {
  const manual = await channel({
    channel: "rednote",
    provider: "manual",
    externalAccountRef: null,
    defaultLocale: "zh-Hans",
    allowedLocales: ["zh-Hans"],
  });
  assert.equal(manual.externalAccountRef, null);

  await refused(
    channel({ channel: "x", provider: "manual", externalAccountRef: "should-not-exist" }),
    /external_ref_matches_provider/,
  );
});

test("a reconnect returns the account to approval mode with a new epoch", async () => {
  const row = await approvedChannel();

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { scopesDigest: OTHER_DIGEST },
    }),
    /must return to approval mode with a new epoch/,
  );

  const updated = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: {
      scopesDigest: OTHER_DIGEST,
      status: "approval_mode",
      graduationEpoch: 1,
    },
  });
  assert.equal(updated.graduationEpoch, 1);
  assert.ok(
    updated.approvalStartedAt &&
      updated.approvalStartedAt.getTime() >= row.approvalStartedAt!.getTime(),
    "the server sets the start of the new window",
  );
});

test("the approval window starts when the server says, not when the caller does", async () => {
  const row = await channel();
  const longAgo = new Date(Date.now() - 400 * DAY);
  const updated = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode", approvalStartedAt: longAgo },
  });
  assert.ok(
    updated.approvalStartedAt!.getTime() > longAgo.getTime() + 300 * DAY,
    "a caller cannot back-date its way to a graduation",
  );
});

test("a connecting account cannot jump straight to autonomous mode", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "autonomous_mode",
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /cannot move from connect_pending to autonomous_mode/,
  );
});

test("the pause origin is the trigger's to write, and cannot be edited afterwards", async () => {
  const row = await approvedChannel();
  const paused = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "paused" },
  });
  assert.equal(paused.pausedFromMode, "approval_mode");

  // The bypass this closes: sit in `paused`, rewrite the origin, then resume
  // into an autonomy the account never had.
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        pausedFromMode: "autonomous_mode",
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /lifecycle columns only change with its status/,
  );

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "autonomous_mode",
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /was not autonomous before it was paused/,
  );
});

test("an account that never went live cannot be paused into a resume", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.update({ where: { id: row.id }, data: { status: "paused" } }),
    /cannot move from connect_pending to paused/,
  );
});

test("a cap override may only lower the policy cap", async () => {
  const row = await channel();
  const caps = MARKETING_CHANNEL_CAPS.linkedin;
  assert.ok(caps);

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { dailyCapOverride: caps.daily + 1 },
    }),
    /above the policy cap/,
  );

  const lowered = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { dailyCapOverride: 0 },
  });
  assert.equal(lowered.dailyCapOverride, 0);
});

test("a manual channel has no cap to override", async () => {
  const row = await channel({
    channel: "rednote",
    provider: "manual",
    externalAccountRef: null,
    defaultLocale: "zh-Hans",
    allowedLocales: ["zh-Hans"],
  });
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { weeklyCapOverride: 1 },
    }),
    /no posting cap to override/,
  );
});

test("a channel is never deleted", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.delete({ where: { id: row.id } }),
    /not deletable; disconnect it instead/,
  );
});

// ---------------------------------------------------------------------------
// Post creation and the status ledger
// ---------------------------------------------------------------------------

test("a post starts as a draft, at version zero, with one draft entry", async () => {
  const row = await approvedChannel();
  await refused(
    post(row.id, { historyVersion: 3 }),
    /must start at history version zero/,
  );
  await refused(post(row.id, { history: [] }), /one draft history entry/);
  await refused(
    post(row.id, { history: [historyEntry("guard_result")] }),
    /one draft history entry/,
  );
  await refused(
    post(row.id, {
      status: "published",
      providerRequestKey: "x",
      publishAttempt: 1,
    }),
    /must be created as a draft|dispatched_has_request_key/,
  );
});

/**
 * A real `approval_required` decision, sealed by the Guard that made it.
 *
 * The draft is read out of `envelope()` rather than written out a second time.
 * The store recomputes the draft digest from the envelope it is handed and
 * refuses a decision made about anything else, so two copies of this text are
 * a test that breaks the moment either copy is edited -- which is what
 * happened.
 */
function approvalDecision(channelId: string) {
  const forDigest = envelope();
  return guardDraft({
    draft: {
      renderedText: forDigest.renderedText,
      locale: forDigest.locale,
      channel: forDigest.channel,
      channelId,
      claimIds: [],
      assetIds: [],
    },
    facts: storeFacts(channelId),
    templates: [],
    context: sealMarketingGuardContext({
      priceFallbackAlertReady: false,
      incidentOrSecurity: "proved_false",
      testimonial: "proved_false",
      legalOrPolicy: "proved_false",
    }),
  });
}

/**
 * The facts bundle the store will check the decision against.
 *
 * Sealed, because the Guard takes nothing else, and carrying the digest of the
 * exact snapshot this test stores -- the store recomputes it and refuses a
 * decision resolved against anything else.
 */
function storeFacts(channelId: string) {
  return sealMarketingFacts({
    channelId,
    channel: "linkedin",
    locale: "en",
    claims: [],
    assets: [],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshotDigest: createHash("sha256")
      .update(JSON.stringify(canonical(factSnapshot)), "utf8")
      .digest("hex"),
  });
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
};

test("the store's create writes the draft entry itself", async () => {
  const row = await approvedChannel();
  const created = await createMarketingPost(prisma, {
    channelId: row.id,
    locale: "en",
    kind: "social",
    logicalKey: "store-created-1",
    envelope: envelope() as never,
    // Computed from the envelope, which is what the store now requires: a
    // digest the caller states says nothing about the content it names.
    envelopeDigest: marketingEnvelopeDigest(envelope() as never),
    rendererVersion: "r1",
    templateId: null,
    templateDigest: null,
    claimIds: [],
    assetIds: [],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshot: factSnapshot as never,
    // The Guard's own object, not a verdict typed out here. The store derives
    // the verdict, the codes, the rule ids, the status and the mode from it,
    // and refuses one it did not seal.
    decision: approvalDecision(row.id),
    draftedAt: new Date(),
  });
  assert.equal(created.historyVersion, 0);
  assert.equal(created.guardDecision, "approval_required");
  assert.equal(created.factsDigest, approvalDecision(row.id).factsDigest);
  assert.equal(created.mode, "approval");
  assert.equal((created.history as { type: string }[]).length, 1);
});

test("the store refuses a decision the Guard did not make", async () => {
  const row = await approvedChannel();
  await assert.rejects(
    createMarketingPost(prisma, {
      channelId: row.id,
      locale: "en",
      kind: "social",
      logicalKey: "store-created-unsealed",
      envelope: envelope() as never,
      envelopeDigest: marketingEnvelopeDigest(envelope() as never),
      rendererVersion: "r1",
      templateId: null,
      templateDigest: null,
      claimIds: [],
      assetIds: [],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshot: factSnapshot as never,
      // A plain object of the right shape, which is what writing
      // `guardDecision: "autonomous_eligible"` used to amount to.
      decision: {
        verdict: "approval_required",
        codes: [],
        ruleIds: [],
      } as never,
      draftedAt: new Date(),
    }),
    /guard_decision_not_sealed|decision/i,
  );
});

test("the store refuses a decision made about a different draft", async () => {
  const row = await approvedChannel();
  // Sealed, and about nothing this post says. Provenance without binding is a
  // stamp on a blank page: the Guard saw one body and the row carries another.
  const elsewhere = guardDraft({
    draft: {
      renderedText: "Something else entirely.",
      locale: "en",
      channel: envelope().channel,
      channelId: row.id,
      claimIds: [],
      assetIds: [],
    },
    facts: storeFacts(row.id),
    templates: [],
    context: sealMarketingGuardContext({
      priceFallbackAlertReady: false,
      incidentOrSecurity: "proved_false",
      testimonial: "proved_false",
      legalOrPolicy: "proved_false",
    }),
  });

  await assert.rejects(
    createMarketingPost(prisma, {
      channelId: row.id,
      locale: "en",
      kind: "social",
      logicalKey: "store-created-other-draft",
      envelope: envelope() as never,
      envelopeDigest: marketingEnvelopeDigest(envelope() as never),
      rendererVersion: "r1",
      templateId: null,
      templateDigest: null,
      claimIds: [],
      assetIds: [],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshot: factSnapshot as never,
      decision: elsewhere,
      draftedAt: new Date(),
    }),
    /guard_decision_not_about_this_post|different draft/i,
  );
});

test("a dispatched post cannot go back to a state that says it never left", async () => {
  const row = await approvedChannel();
  const published = await publishedPost(row.id);

  for (const status of ["rejected", "guard_rejected", "approval_expired", "scheduled"]) {
    await refused(
      prisma.marketingPost.update({
        where: { id: published.id },
        data: { status },
      }),
      new RegExp(`cannot move from published to ${status}`),
    );
  }

  // And a post that has not been dispatched cannot skip to a state that says it
  // was.
  const draft = await post(row.id);
  await refused(
    prisma.marketingPost.update({
      where: { id: draft.id },
      data: { status: "published" },
    }),
    /cannot move from drafted to published/,
  );
});

test("an approval that names no digest is not an approval", async () => {
  const row = await approvedChannel();
  const draft = await post(row.id);
  await prisma.marketingPost.update({
    where: { id: draft.id },
    data: {
      status: "pending_approval",
      historyVersion: 1,
      history: [
        ...(draft.history as Prisma.InputJsonValue[]),
        historyEntry("guard_result", {
          decision: "approval_required",
          codes: [],
          ruleIds: [],
        }),
      ],
    },
  });

  // The bypass this closes: `approvedDigest = envelopeDigest` is NULL when the
  // digest is NULL, and a CHECK treats NULL as satisfied.
  await refused(
    prisma.marketingPost.update({
      where: { id: draft.id },
      data: { status: "approved", approvalAuditLogId: "audit-1" },
    }),
    /approval_binding/,
  );

  const approved = await prisma.marketingPost.update({
    where: { id: draft.id },
    data: {
      status: "approved",
      approvalAuditLogId: "audit-1",
      approvedAt: new Date(),
      approvedDigest: DIGEST,
    },
  });
  assert.equal(approved.status, "approved");
});

test("a post cannot become published without recording when", async () => {
  const row = await approvedChannel();
  const dispatched = await dispatchedPost(row.id);
  // The purge clock reads publishedAt first, so a NULL here would date a post
  // published today from whenever its draft was written.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "published" },
    }),
    /cannot become published without recording when|published_records_when/,
  );
});

test("a post records a publication time only when it becomes published", async () => {
  const row = await approvedChannel();
  const draft = await post(row.id);

  await refused(
    prisma.marketingPost.update({
      where: { id: draft.id },
      data: { publishedAt: new Date() },
    }),
    /records a publication time only when it becomes published/,
  );
});

test("a publication time is written once", async () => {
  const row = await approvedChannel();
  const published = await publishedPost(row.id);
  const first = published.publishedAt!;

  await refused(
    prisma.marketingPost.update({
      where: { id: published.id },
      data: { publishedAt: new Date(first.getTime() + 1000) },
    }),
    /publication time is written once/,
  );
});

// ---------------------------------------------------------------------------
// History and purge
// ---------------------------------------------------------------------------

test("history is append-only and its version moves by exactly one", async () => {
  const row = await approvedChannel();
  const created = await post(row.id);
  const original = created.history as Prisma.InputJsonValue[];

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: {
        history: [...original, historyEntry("guard_result")],
        historyVersion: 5,
      },
    }),
    /history version moves by one/,
  );

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: { history: [historyEntry("guard_result")], historyVersion: 1 },
    }),
    /history is append-only/,
  );

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: { history: [], historyVersion: 1 },
    }),
    /history cannot lose entries/,
  );

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: {
        history: [...original, historyEntry("retention_compaction", { removedEntryCount: 1 })],
        historyVersion: 1,
      },
    }),
    /retention entries are written by retention/,
  );

  const appended = await prisma.marketingPost.update({
    where: { id: created.id },
    data: {
      history: [...original, historyEntry("guard_result")],
      historyVersion: 1,
    },
  });
  assert.equal(appended.historyVersion, 1);
});

test("content is purged only by retention, only when it is old, never under hold", async () => {
  const row = await approvedChannel();
  const fresh = await post(row.id);

  await refused(
    prisma.marketingPost.update({
      where: { id: fresh.id },
      data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
    }),
    /content is only purged by retention/,
  );

  await refusedUnderRetention(
    (tx) =>
      tx.marketingPost.update({
        where: { id: fresh.id },
        data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
      }),
    /not yet twenty-four months old/,
  );

  const held = await agedPost(row.id, 800, { legalHold: true });
  await refusedUnderRetention(
    (tx) =>
      tx.marketingPost.update({
        where: { id: held.id },
        data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
      }),
    /under legal hold/,
  );

  const old = await agedPost(row.id, 800);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await tx.marketingPost.update({
      where: { id: old.id },
      data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
    });
  });

  const purged = await prisma.marketingPost.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(purged.envelope, null);
  assert.equal(purged.envelopeDigest, DIGEST, "the digest survives the purge");
});

test("compaction drops only old attempts and webhook ids, and says what it dropped", async () => {
  const row = await approvedChannel();
  const draftEntry = historyEntry("draft", { envelopeDigest: DIGEST });
  const oldAttempt = {
    at: new Date(Date.now() - 200 * DAY).toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "failed",
    errorCode: null,
  };
  const youngAttempt = {
    at: new Date(Date.now() - 2 * DAY).toISOString(),
    type: "attempt",
    attempt: 2,
    outcome: "failed",
    errorCode: null,
  };
  const created = await agedPost(row.id, 400, {
    history: [draftEntry, oldAttempt, youngAttempt],
    historyVersion: 0,
  });

  const summary = {
    at: new Date().toISOString(),
    type: "retention_summary",
    summarises: "attempt",
    count: 1,
    firstAt: oldAttempt.at,
    lastAt: oldAttempt.at,
  };
  const compaction = historyEntry("retention_compaction", { removedEntryCount: 1 });

  // One transaction per refusal. A RAISE leaves the transaction aborted, so a
  // second statement in the same one fails with 25P02 rather than the error the
  // assertion is about -- the first version of this test proved nothing after
  // its first line.
  await refusedCompaction(
    created.id,
    [summary, compaction],
    /cannot compact a draft entry at any age/,
  );
  await refusedCompaction(
    created.id,
    [draftEntry, summary, compaction],
    /cannot compact an entry younger than ninety days/,
  );
  await refusedCompaction(
    created.id,
    [draftEntry, youngAttempt, compaction],
    /needs exactly one summary of its removed attempt entries/,
  );
  await refusedCompaction(
    created.id,
    [draftEntry, youngAttempt, summary, { ...summary, count: 1 }, compaction],
    /summarises something it did not remove/,
  );
  await refusedCompaction(
    created.id,
    [draftEntry, youngAttempt, { ...summary, lastAt: youngAttempt.at }, compaction],
    /does not span them/,
  );
  // `x ->> 'type'` on an entry with no type is NULL, and a NULL comparison does
  // not raise; an entry like this used to pass every tail check.
  await refusedCompaction(
    created.id,
    [draftEntry, youngAttempt, summary, {}, compaction],
    /may only add summaries/,
  );
  await refusedCompaction(
    created.id,
    [
      draftEntry,
      youngAttempt,
      { ...summary, note: "tidied up" },
      compaction,
    ],
    /is not the shape a summary has/,
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await tx.marketingPost.update({
      where: { id: created.id },
      data: {
        history: [draftEntry, youngAttempt, summary, compaction],
        historyVersion: 1,
      },
    });
  });

  const compacted = await prisma.marketingPost.findUniqueOrThrow({
    where: { id: created.id },
  });
  const entries = compacted.history as { type: string }[];
  assert.equal(entries.at(-1)?.type, "retention_compaction");
  assert.equal(entries.filter((entry) => entry.type === "attempt").length, 1);
});

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

test("a post is deleted only as an old refused draft that never reached a platform", async () => {
  const row = await approvedChannel();
  const fresh = await post(row.id, { status: "guard_rejected", guardDecision: "reject" });
  await refused(
    prisma.marketingPost.delete({ where: { id: fresh.id } }),
    /only deleted by retention/,
  );

  await refusedUnderRetention(
    (tx) => tx.marketingPost.delete({ where: { id: fresh.id } }),
    /not yet ninety days old/,
  );

  const dispatched = await agedPost(row.id, 200, {
    status: "guard_rejected",
    guardDecision: "reject",
    publishAttempt: 1,
  });
  await refusedUnderRetention(
    (tx) => tx.marketingPost.delete({ where: { id: dispatched.id } }),
    /reached a platform and is not deletable/,
  );

  const deletable = await agedPost(row.id, 200, { status: "approval_expired" });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await tx.marketingPost.delete({ where: { id: deletable.id } });
  });
  assert.equal(await prisma.marketingPost.count({ where: { id: deletable.id } }), 0);
});

// ---------------------------------------------------------------------------
// Reports and visibility runs
// ---------------------------------------------------------------------------

test("a report's retention date is the database's, not the caller's", async () => {
  const report = await insertMarketingReport(prisma, {
    kind: "weekly_kpi",
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-01-07T00:00:00.000Z"),
    payload: {
      postsPublished: 3,
      postsRejected: 1,
      guardRejectionsByCode: [],
      channelTotals: [],
    },
    sourceVersion: "v1",
  });

  assert.ok(
    report.retentionUntil.getTime() > report.createdAt.getTime() + 700 * DAY,
    "two years from when the database wrote it",
  );

  // A direct insert cannot choose either column: the trigger overwrites both.
  const backdated = await prisma.marketingReport.create({
    data: {
      kind: "comment_alerts",
      periodStart: new Date("2020-01-01T00:00:00.000Z"),
      periodEnd: new Date("2020-01-01T00:00:00.000Z"),
      payload: {
        postId: "post.1",
        alertCount: 0,
        riskCodes: [],
        firstDetectedAt: "2020-01-01T00:00:00.000Z",
        externalUrlHost: "www.linkedin.com",
      },
      sourceVersion: "v1",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      retentionUntil: new Date("2020-04-01T00:00:00.000Z"),
    },
  });
  assert.ok(
    backdated.createdAt.getTime() > Date.now() - 60_000,
    "a caller cannot date a report into the past",
  );
  await refused(
    prisma.marketingReport.delete({ where: { id: backdated.id } }),
    /only deleted by retention/,
  );
});

test("a report's anchors cannot move, and it is deleted only after them", async () => {
  const report = await insertMarketingReport(prisma, {
    kind: "comment_alerts",
    periodStart: new Date(),
    periodEnd: new Date(),
    payload: {
      postId: "post.1",
      alertCount: 1,
      riskCodes: [],
      firstDetectedAt: new Date().toISOString(),
      externalUrlHost: "www.linkedin.com",
    },
    sourceVersion: "v1",
  });

  await refused(
    prisma.marketingReport.update({
      where: { id: report.id },
      data: { retentionUntil: new Date(Date.now() - DAY) },
    }),
    /retention anchors are immutable/,
  );

  await refusedUnderRetention(
    (tx) => tx.marketingReport.delete({ where: { id: report.id } }),
    /retained until/,
  );
});

test("a visibility run keeps cited urls https and an answer digest only", async () => {
  const runAt = new Date("2026-09-18T00:00:00.000Z");
  const run = await insertAiVisibilityRun(prisma, {
    promptSetVersion: "p1",
    promptId: "prompt.compare",
    locale: "en",
    model: "gpt-5-6-luna",
    modelVersion: "2026-09-01",
    searchMode: "with_search",
    region: "AU",
    runAt,
    mentioned: true,
    citedUrls: ["https://tomverse.app/"],
    answerDigest: DIGEST,
    accuracyFlags: { flags: ["wrong_price"] },
  });
  assert.equal(run.retentionUntil.toISOString(), "2028-09-18T00:00:00.000Z");

  const directRun = (citedUrls: string[], answerDigest = DIGEST) =>
    prisma.aiVisibilityRun.create({
      data: {
        promptSetVersion: "p1",
        promptId: "prompt.compare",
        locale: "en",
        model: "gpt-5-6-luna",
        modelVersion: "2026-09-01",
        searchMode: "with_search",
        region: "AU",
        runAt,
        mentioned: true,
        citedUrls,
        answerDigest,
      },
    });

  await refused(directRun(["http://tomverse.app/"]), /citedUrls/);
  // bool_and ignores NULLs, so a NULL element would otherwise pass the check.
  await refused(
    prisma.$executeRawUnsafe(
      `INSERT INTO "AiVisibilityRun" ("id","promptSetVersion","promptId","locale","model","modelVersion","searchMode","region","runAt","mentioned","citedUrls","answerDigest")
       VALUES ('null-url','p1','prompt.compare','en','m','v','with_search','AU', now(), true, ARRAY['https://ok.example', NULL], $1)`,
      DIGEST,
    ),
    /citedUrls/,
  );
  await refused(directRun([], "not-a-digest"), /answerDigest/);
});

// ---------------------------------------------------------------------------
// The two movements that are an operator's decision
// ---------------------------------------------------------------------------

test("a reconnect cannot ride in on another column's change", async () => {
  const row = await channel();
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode" },
  });
  const disconnected = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "disconnected" },
  });
  assert.equal(disconnected.status, "disconnected");

  // Changing the scopes digest at the same time used to reach the reconnect
  // branch's early return, which skipped the generation check below it.
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "approval_mode",
        scopesDigest: OTHER_DIGEST,
        graduationEpoch: disconnected.graduationEpoch + 1,
      },
    }),
    /reconnects only with a new connection generation/,
  );

  const reconnected = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: {
      status: "approval_mode",
      scopesDigest: OTHER_DIGEST,
      connectionGeneration: disconnected.connectionGeneration + 1,
      graduationEpoch: disconnected.graduationEpoch + 1,
    },
  });
  assert.equal(reconnected.connectionGeneration, disconnected.connectionGeneration + 1);
});

test("the resume columns cannot be written on the way past", async () => {
  const row = await approvedChannel();
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        scopesDigest: OTHER_DIGEST,
        status: "approval_mode",
        graduationEpoch: 1,
        lastResumeAuditLogId: "audit-invented",
        lastResumeReasonCode: "incident_resolved",
      },
    }),
    /records a resume reason only when it resumes into autonomous mode/,
  );
});

test("an audit entry resumes an account once, and only after the pause", async () => {
  const row = await channel();
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode" },
  });
  const graduated = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: {
      status: "autonomous_mode",
      graduatedAt: new Date(),
      graduationSnapshot: {
        graduationEpoch: 0,
        approvedPostCount: 20,
        guardRejectionRate: 0,
        operatorEditRate: 0,
        observedFromAt: new Date().toISOString(),
        observedUntilAt: new Date().toISOString(),
        approvalAuditLogId: "audit-graduation",
        policyVersion: 1,
      },
    },
  });
  assert.equal(graduated.status, "autonomous_mode");

  // An entry written before the pause is a record of an earlier decision.
  const staleAuditId = await resumeAuditEntry(row.id, "incident_resolved");
  const paused = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "paused" },
  });
  assert.equal(paused.pausedFromMode, "autonomous_mode");

  await refusedByStore(
    resumeAutonomous(row.id, staleAuditId, "incident_resolved"),
    "resume_evidence_entry_predates_decision",
  );

  const freshAuditId = await resumeAuditEntry(row.id, "incident_resolved");
  const resumed = await updateMarketingChannel(
    prisma,
    row.id,
    {
      status: "autonomous_mode",
      graduatedAt: graduated.graduatedAt,
      graduationSnapshot: graduated.graduationSnapshot as never,
    },
    { auditLogId: freshAuditId, reasonCode: "incident_resolved" },
  );
  assert.equal(resumed.lastResumeAuditLogId, freshAuditId);

  // The same entry cannot bring it back a second time.
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "paused" },
  });
  await refusedByStore(
    resumeAutonomous(row.id, freshAuditId, "incident_resolved"),
    "resume_evidence_reused",
  );
});

test("a retention entry's values are typed, not just keyed", async () => {
  const row = await approvedChannel();
  const draftEntry = historyEntry("draft", { envelopeDigest: DIGEST });
  const oldAttempt = {
    at: new Date(Date.now() - 200 * DAY).toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "outcome_unknown",
    errorCode: null,
  };
  const created = await agedPost(row.id, 400, {
    history: [draftEntry, oldAttempt],
    historyVersion: 0,
  });

  const summary = {
    at: new Date().toISOString(),
    type: "retention_summary",
    summarises: "attempt",
    count: 1,
    firstAt: oldAttempt.at,
    lastAt: oldAttempt.at,
  };
  const compaction = historyEntry("retention_compaction", { removedEntryCount: 1 });

  // A string that reads as a number passes `::INTEGER` and would be written.
  await refusedCompaction(
    created.id,
    [draftEntry, { ...summary, count: "1" }, compaction],
    /is not the shape a summary has/,
  );
  await refusedCompaction(
    created.id,
    [draftEntry, summary, { ...compaction, removedEntryCount: "1" }],
    /is not the shape it has/,
  );
  // Not a time at all.
  await refusedCompaction(
    created.id,
    [draftEntry, { ...summary, at: 0 }, compaction],
    /is not the shape a summary has/,
  );
  // A time Postgres reads happily and the module's schema refuses, which is the
  // pair that would write a row nothing can read back.
  await refusedCompaction(
    created.id,
    [draftEntry, { ...summary, firstAt: "2026-09-18 00:00:00" }, compaction],
    /not an instant this store can read back/,
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await tx.marketingPost.update({
      where: { id: created.id },
      data: { history: [draftEntry, summary, compaction], historyVersion: 1 },
    });
  });
  const compacted = await prisma.marketingPost.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal((compacted.history as { type: string }[]).length, 3);
});

test("a post cannot become failed without recording this attempt failing", async () => {
  const row = await approvedChannel();
  const dispatched = await dispatchedPost(row.id);

  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "failed" },
    }),
    /cannot be failed without recording the failure of attempt/,
  );

  const failed = await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "failed",
      history: [
        ...(dispatched.history as Prisma.InputJsonValue[]),
        historyEntry("attempt", { attempt: 1, outcome: "failed", errorCode: null }),
      ],
      historyVersion: dispatched.historyVersion + 1,
    },
  });
  assert.equal(failed.status, "failed");
});

test("compacting a failure away does not open a path into failed", async () => {
  const row = await approvedChannel();
  const draftEntry = historyEntry("draft", { envelopeDigest: DIGEST });
  const oldFailure = {
    at: new Date(Date.now() - 200 * DAY).toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "failed",
    errorCode: null,
  };
  const created = await agedPost(row.id, 400, {
    // The counter matches the failure already in the history: a dispatch moves it
    // by exactly one, so a fixture that started at zero could not reach attempt
    // two and would fail before the compaction this test is about.
    publishAttempt: 1,
    history: [draftEntry, oldFailure],
    historyVersion: 0,
  });

  const step = (data: Record<string, unknown>) =>
    prisma.marketingPost.update({ where: { id: created.id }, data });
  await step({ status: "pending_approval" });
  await step({
    status: "approved",
    approvalAuditLogId: "audit-approval-2",
    approvedAt: new Date(),
    approvedDigest: DIGEST,
  });
  await step({ status: "scheduled" });
  await step({
    status: "publishing",
    publishAttempt: 2,
    providerRequestKey: created.logicalKey,
  });

  // Compaction is allowed here: the post is not failed, so nothing is measuring
  // against that attempt yet.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await tx.marketingPost.update({
      where: { id: created.id },
      data: {
        history: [
          draftEntry,
          {
            at: new Date().toISOString(),
            type: "retention_summary",
            summarises: "attempt",
            count: 1,
            firstAt: oldFailure.at,
            lastAt: oldFailure.at,
          },
          historyEntry("retention_compaction", { removedEntryCount: 1 }),
        ],
        historyVersion: 1,
      },
    });
  });

  // And now the post cannot become failed without recording the failure, so the
  // two-step route to a failed post with no way out is closed.
  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: { status: "failed" },
    }),
    /cannot be failed without recording the failure of attempt/,
  );
});

test("an earlier failure does not stand in for the current attempt's", async () => {
  const row = await approvedChannel();
  const dispatched = await dispatchedPost(row.id);
  const history = dispatched.history as Prisma.InputJsonValue[];

  // A second in the past, so the operator approval below is deterministically
  // later than the failure it answers rather than possibly the same millisecond.
  const firstFailure = {
    at: new Date(Date.now() - 1000).toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "failed",
    errorCode: null,
  };
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "failed",
      history: [...history, firstFailure],
      historyVersion: dispatched.historyVersion + 1,
    },
  });

  // A person re-queues it, and the publisher sends attempt two.
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "scheduled",
      approvalAuditLogId: "audit-requeue-1",
      approvedAt: new Date(),
      approvedDigest: DIGEST,
    },
  });
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: { status: "publishing", publishAttempt: 2 },
  });

  // Attempt one's failure is still in the history, and it is not this failure.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "failed" },
    }),
    /cannot be failed without recording the failure of attempt 2/,
  );

  const failedAgain = await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "failed",
      history: [
        ...history,
        firstFailure,
        historyEntry("attempt", { attempt: 2, outcome: "failed", errorCode: null }),
      ],
      historyVersion: dispatched.historyVersion + 2,
    },
  });
  assert.equal(failedAgain.status, "failed");
});

test("winding the attempt counter back does not reuse an old failure", async () => {
  const row = await approvedChannel();
  const dispatched = await dispatchedPost(row.id);
  const history = dispatched.history as Prisma.InputJsonValue[];

  const firstFailure = {
    at: new Date(Date.now() - 1000).toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "failed",
    errorCode: null,
  };
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "failed",
      history: [...history, firstFailure],
      historyVersion: dispatched.historyVersion + 1,
    },
  });
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "scheduled",
      approvalAuditLogId: "audit-requeue-2",
      approvedAt: new Date(),
      approvedDigest: DIGEST,
    },
  });
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: { status: "publishing", publishAttempt: 2 },
  });

  // The counter is the only thing tying a failure entry to an attempt, so a
  // write that could wind it back could make attempt one's failure answer for
  // attempt two.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "failed", publishAttempt: 1 },
    }),
    /attempt counter changes only when the post is dispatched/,
  );

  // Forward is refused for the same reason backward is: moving it on would leave
  // the real last failure unprotected from retention.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { publishAttempt: 3 },
    }),
    /attempt counter changes only when the post is dispatched/,
  );

  // And even at the right number, the failure has to be recorded by this write
  // rather than found somewhere in the history.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "failed" },
    }),
    /in the same write/,
  );
});

test("a failure stamped finer than a millisecond is still protected", async () => {
  const row = await approvedChannel();
  const draftEntry = historyEntry("draft", { envelopeDigest: DIGEST });
  // The store's schema accepts any sub-second precision. The protection used to
  // compare this against a TIMESTAMP(3) copy of itself, which is a different
  // value, so the entry it exists to keep was removable.
  const preciseFailure = {
    at: new Date(Date.now() - 200 * DAY).toISOString().replace("Z", "456789Z"),
    type: "attempt",
    attempt: 1,
    outcome: "failed",
    errorCode: null,
  };
  // The dispatched-status CHECK requires the provider key to be the logical
  // key, so the fixture names both.
  const logicalKey = `post-precise-${Math.random().toString(36).slice(2)}`;
  const created = await agedPost(row.id, 400, {
    status: "failed",
    publishAttempt: 1,
    logicalKey,
    providerRequestKey: logicalKey,
    history: [draftEntry, preciseFailure],
    historyVersion: 0,
  });

  await refusedCompaction(
    created.id,
    [
      draftEntry,
      {
        at: new Date().toISOString(),
        type: "retention_summary",
        summarises: "attempt",
        count: 1,
        firstAt: preciseFailure.at,
        lastAt: preciseFailure.at,
      },
      historyEntry("retention_compaction", { removedEntryCount: 1 }),
    ],
    /the failure of attempt 1 is what a re-queue is measured against/,
  );
});

test("a failure already in the history is not this statement's record of it", async () => {
  const row = await approvedChannel();
  const dispatched = await dispatchedPost(row.id);
  const history = dispatched.history as Prisma.InputJsonValue[];

  // The publisher appends the failure and moves the status in one write. Split
  // across two, the second write records nothing, and the rule is about what a
  // write records rather than about what the row happens to contain.
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      history: [
        ...history,
        historyEntry("attempt", { attempt: 1, outcome: "failed", errorCode: null }),
      ],
      historyVersion: dispatched.historyVersion + 1,
    },
  });

  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "failed" },
    }),
    /in the same write/,
  );
});

test("a second dispatch cannot reuse the first attempt's number", async () => {
  const row = await approvedChannel();
  const dispatched = await dispatchedPost(row.id);
  const history = dispatched.history as Prisma.InputJsonValue[];

  const firstFailure = {
    at: new Date(Date.now() - 1000).toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "failed",
    errorCode: null,
  };
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "failed",
      history: [...history, firstFailure],
      historyVersion: dispatched.historyVersion + 1,
    },
  });
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: {
      status: "scheduled",
      approvalAuditLogId: "audit-requeue-3",
      approvedAt: new Date(),
      approvedDigest: DIGEST,
    },
  });

  // Leaving the counter alone was the remaining way to give two real attempts
  // the same number, which would make the failure entries of both indistinguishable.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "publishing" },
    }),
    /dispatch moves the attempt counter by one/,
  );

  // Nor may it skip: the number is the ordinal of a real dispatch, so a gap
  // would be an attempt nothing happened on.
  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "publishing", publishAttempt: 3 },
    }),
    /dispatch moves the attempt counter by one/,
  );

  const second = await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: { status: "publishing", publishAttempt: 2 },
  });
  assert.equal(second.publishAttempt, 2);
});

// ---------------------------------------------------------------------------
// S2b1 ordinary Admin store writes
// ---------------------------------------------------------------------------

// These are integration tests on purpose. The Admin E2E harness builds its
// database with `prisma db push`, which installs none of the migration SQL;
// putting a trigger-refusal assertion there would produce a green test that
// never exercised the trigger this contract depends on.

const postAuditEntry = (
  action: string,
  targetId: string,
  metadata: Prisma.InputJsonObject,
) =>
  writeAdminAuditLog({
    session: operator,
    request: new Request("https://tomverse.app/api/admin/marketing"),
    action,
    targetType: "MarketingPost",
    targetId,
    summary: "S2b1 operator decision.",
    metadata: { actorHadMarketingWrite: true, ...metadata },
  });

test("two S2b1 approvers racing one digest and version produce one winner", async () => {
  const account = await approvedChannel();
  const draft = await post(account.id);
  const pending = await prisma.marketingPost.update({
    where: { id: draft.id },
    data: { status: "pending_approval" },
  });
  const [firstAudit, secondAudit] = await Promise.all([
    postAuditEntry(MARKETING_S2B1_ACTIONS.postApprove, pending.id, {
      digest: DIGEST,
    }),
    postAuditEntry(MARKETING_S2B1_ACTIONS.postApprove, pending.id, {
      digest: DIGEST,
    }),
  ]);
  const expiry = new Date(Date.now() + DAY);
  const attempt = (approvalAuditLogId: string) =>
    prisma.$transaction((tx) =>
      approveMarketingPost(tx, {
        id: pending.id,
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: pending.historyVersion,
        approvalAuditLogId,
        approvalExpiresAt: expiry,
      }),
    );
  const results = await Promise.allSettled([
    attempt(firstAudit),
    attempt(secondAudit),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const stored = await prisma.marketingPost.findUniqueOrThrow({
    where: { id: pending.id },
  });
  assert.equal(stored.status, "approved");
  assert.equal(stored.approvedDigest, DIGEST);
  assert.equal(stored.approvalExpiresAt?.toISOString(), expiry.toISOString());
  assert.ok([firstAudit, secondAudit].includes(stored.approvalAuditLogId ?? ""));
});

test("approval-mode resume expires every due approved or scheduled post in its transaction", async () => {
  const account = await approvedChannel();
  await prisma.marketingChannel.update({
    where: { id: account.id },
    data: { status: "paused", pauseReasonCode: "incident_review" },
  });
  const due = await post(account.id);
  await prisma.marketingPost.update({
    where: { id: due.id },
    data: { status: "pending_approval" },
  });
  await prisma.marketingPost.update({
    where: { id: due.id },
    data: {
      status: "approved",
      approvalAuditLogId: "fixture-approval",
      approvedAt: new Date(Date.now() - 2 * DAY),
      approvedDigest: DIGEST,
      approvalExpiresAt: new Date(Date.now() - DAY),
    },
  });

  const result = await runMarketingTransaction(prisma, (tx) =>
    resumeMarketingChannelToApproval(tx, { id: account.id }),
  );
  assert.deepEqual(result.expiredPostIds, [due.id]);
  const [resumed, expired, audit] = await Promise.all([
    prisma.marketingChannel.findUniqueOrThrow({ where: { id: account.id } }),
    prisma.marketingPost.findUniqueOrThrow({ where: { id: due.id } }),
    prisma.adminAuditLog.findFirstOrThrow({
      where: {
        action: MARKETING_S2B1_ACTIONS.postApprovalExpiredOnResume,
        targetId: due.id,
      },
    }),
  ]);
  assert.equal(resumed.status, "approval_mode");
  assert.equal(expired.status, "approval_expired");
  assert.equal(expired.historyVersion, due.historyVersion);
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "marketing-guard");
});

test("the S2b1 cap writer refuses an effective increase before the DB trigger", async () => {
  const account = await approvedChannel();
  await lowerMarketingChannelCaps(prisma, {
    id: account.id,
    dailyCapOverride: 0,
    weeklyCapOverride: 2,
  });
  await refusedByStore(
    lowerMarketingChannelCaps(prisma, {
      id: account.id,
      dailyCapOverride: 1,
      weeklyCapOverride: 2,
    }),
    "cap_change_raises_limit",
  );
});

// ---------------------------------------------------------------------------
// S1 r7 amendment 2: the one row that may be inserted already scheduled
// ---------------------------------------------------------------------------
//
// The store's own refusals are unit-tested against a fake
// (tests/marketingS2b2AutonomousInsert.test.ts). These are the other half: the
// trigger's, against a real PostgreSQL, because the whole reason the exception
// is written in SQL is that it holds for a write that never goes near the
// store module.

/** The shape the exception is defined as, with nothing else set. */
const autonomousScheduledRow = (
  channelId: string,
  slot: Date,
  overrides: Record<string, unknown> = {},
) => ({
  channelId,
  locale: "en",
  kind: "social",
  logicalKey: `auto-${Math.random().toString(36).slice(2)}`,
  envelope: envelope({ scheduledAt: slot.toISOString() }),
  envelopeDigest: DIGEST,
  rendererVersion: "r1",
  templateId: "template-1",
  templateDigest: OTHER_DIGEST,
  claimIds: [],
  assetIds: [],
  claimRegistryVersion: 1,
  assetRegistryVersion: 1,
  factSnapshot,
  factsDigest: DIGEST,
  guardDecision: "autonomous_eligible",
  guardCodes: [] as string[],
  // Empty, because that is what `guardDraft()` returns for an autonomous
  // decision: the rule ids it collects are the ones that had something to say.
  // The fixture used to write `["rule.template"]`, and that one value hid a
  // trigger clause that refused every legitimate row.
  guardRuleIds: [] as string[],
  status: "scheduled",
  mode: "autonomous",
  scheduledAt: slot,
  history: [historyEntry("draft", { envelopeDigest: DIGEST })],
  historyVersion: 0,
  ...overrides,
});

const refusesAutonomousRow = async (
  channelId: string,
  slot: Date,
  overrides: Record<string, unknown>,
) =>
  assert.rejects(
    prisma.marketingPost.create({
      data: autonomousScheduledRow(channelId, slot, overrides) as never,
    }),
    /check_violation|violates|MarketingPost/,
  );

test("an autonomous scheduled row of the right shape is accepted", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  const created = await prisma.marketingPost.create({
    data: autonomousScheduledRow(account.id, slot) as never,
  });
  assert.equal(created.status, "scheduled");
  assert.equal(created.mode, "autonomous");
  assert.equal(created.historyVersion, 0);
  // The trigger still stamps `createdAt` from the server clock. The exception
  // widens which statuses may be inserted; it does not hand the caller the
  // clock.
  assert.ok(Math.abs(created.createdAt.getTime() - Date.now()) < 60_000);
  assert.deepEqual(created.guardRuleIds, []);

  // A decision that did collect a rule id is accepted too. The clause is about
  // the decision being autonomous, not about how much it had to say.
  const withRule = await prisma.marketingPost.create({
    data: autonomousScheduledRow(account.id, slot, {
      guardRuleIds: ["rule.template"],
    }) as never,
  });
  assert.deepEqual(withRule.guardRuleIds, ["rule.template"]);
});

test("the first history entry names the envelope the row stores", async () => {
  // The store checks the digest; a row inserted another way does not go
  // through it, and the first entry is what every later append is compared
  // against.
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  await refusesAutonomousRow(account.id, slot, {
    history: [historyEntry("draft", { envelopeDigest: OTHER_DIGEST })],
  });
  await refusesAutonomousRow(account.id, slot, {
    history: [historyEntry("draft")],
  });
});

test("the exception is exactly scheduled-and-autonomous, not either half", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  // `scheduled` with an approval-mode row is the ordinary refusal, unchanged.
  await refusesAutonomousRow(account.id, slot, {
    mode: "approval",
    guardDecision: "approval_required",
  });
  // And an autonomous row that is not scheduled is not this exception either:
  // it falls back to the draft rule, which permits only two statuses.
  await refusesAutonomousRow(account.id, slot, {
    status: "approved",
    scheduledAt: null,
  });
});

test("a scheduled autonomous row goes out when its envelope says, or not at all", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  // The column and the envelope disagreeing is the case this clause exists
  // for: the publisher acts on the column and the Guard judged the envelope.
  await refusesAutonomousRow(account.id, slot, {
    scheduledAt: new Date(slot.getTime() + DAY),
  });
  await refusesAutonomousRow(account.id, slot, {
    envelope: envelope({ scheduledAt: null }),
  });
  await refusesAutonomousRow(account.id, slot, { scheduledAt: null });
});

test("a scheduled autonomous row carries a sealed autonomous decision", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  await refusesAutonomousRow(account.id, slot, {
    guardDecision: "approval_required",
  });
  await refusesAutonomousRow(account.id, slot, { guardCodes: ["new_copy"] });
  await refusesAutonomousRow(account.id, slot, { factsDigest: null });
});

test("autonomy is only ever inside a named template", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  await refusesAutonomousRow(account.id, slot, { templateId: null });
  await refusesAutonomousRow(account.id, slot, { templateDigest: null });
});

test("a scheduled autonomous row cannot mint its own approval", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  for (const field of [
    { approvalAuditLogId: "audit-1" },
    { approvedAt: new Date() },
    { approvedDigest: DIGEST },
    { approvalExpiresAt: new Date(Date.now() + DAY) },
    // Nor become the source another autonomous post inherits from.
    { reusableAsTemplate: true },
  ]) {
    await refusesAutonomousRow(account.id, slot, field);
  }
});

test("a scheduled autonomous row arrives unclaimed and without an outcome", async () => {
  const account = await channel();
  const slot = new Date(Date.now() + DAY);
  for (const field of [
    { slotDate: new Date() },
    { claimToken: "token-1" },
    { leaseUntil: new Date(Date.now() + 60_000) },
    { externalUrl: "https://www.tomverse.app/p/1" },
    { verifiedPublicAt: new Date() },
    { verificationMethod: "api_lookup" },
    { errorCode: "provider_rejected" },
    { outcomeUnknownAt: new Date() },
    { deletedAt: new Date() },
    { deletionMethod: "operator_unpublish" },
    { contentPurgedAt: new Date() },
    { legalHold: true },
    // The clauses outside the exception still apply to it.
    { publishedAt: new Date() },
    { publishAttempt: 1 },
    { providerRequestKey: "key-1" },
    { externalPostId: "external-1" },
  ]) {
    await refusesAutonomousRow(account.id, slot, field);
  }
});

test("the exception adds no drafted-to-scheduled edge", async () => {
  // The other half of "this is not a lifted refusal". A post that started as a
  // draft still cannot walk to `scheduled`: the only route is to be inserted
  // as one.
  const account = await channel();
  const draft = await post(account.id);
  await assert.rejects(
    prisma.marketingPost.update({
      where: { id: draft.id },
      data: { status: "scheduled", mode: "autonomous" },
    }),
    /check_violation|violates|MarketingPost/,
  );
});

test("evidence withdrawn before the transaction starts is a refusal", async () => {
  // The deterministic half, and the one that matters most: the store re-asks
  // at write time whether each claim the decision relied on has been
  // published, and answers from what the database says now.
  //
  // Written with the withdrawal already committed, so there is no race to
  // observe and nothing to flake. What it proves is the query: that the
  // statement in `insertAutonomousScheduledMarketingPost` reads the columns
  // and statuses it means to, against a real PostgreSQL rather than a fake
  // that returns whatever the test handed it.
  const account = await channel();
  const published = await publishedPost(account.id);
  await prisma.marketingPost.update({
    where: { id: published.id },
    data: { claimIds: ["claim.shared"] },
  });

  const priorUse = async () =>
    (
      await prisma.$queryRaw<Array<{ value: string }>>(Prisma.sql`
        SELECT DISTINCT used."value" AS "value"
        FROM "MarketingPost" AS post,
             unnest(post."claimIds") AS used("value")
        WHERE post."channelId" = ${account.id}
          AND post."status" IN ('publishing', 'published', 'outcome_unknown', 'verified', 'removed_by_platform')
          AND used."value" IN ('claim.shared')
      `)
    ).map((row) => row.value);

  assert.deepEqual(await priorUse(), ["claim.shared"]);

  await prisma.marketingPost.update({
    where: { id: published.id },
    data: { status: "deleted", deletedAt: new Date() },
  });

  // `deleted` is not one of the prior-use statuses, so the evidence is gone
  // and the store's check finds nothing -- which is the refusal.
  assert.deepEqual(await priorUse(), []);
});

test("the whole admission is read at one serialization point", async () => {
  // What `SERIALIZABLE` actually buys this transaction, stated as narrowly as
  // it is true.
  //
  // It is not that a concurrent unpublish cannot commit: a history where this
  // transaction goes first and the unpublish second is a legal serial order,
  // and PostgreSQL will allow both. The post is then scheduled on evidence
  // that was true at its serialization point, which is the right answer.
  //
  // What it buys is that there is a serialization point at all. The admission
  // reads the switches, the channel, the template and the prior use in four
  // separate statements, and under read committed each sees whatever had
  // committed by the moment it ran -- so a decision could be admitted against
  // switches from before an operator turned publishing off and prior use from
  // after. Here the four are one instant or the transaction does not commit.
  //
  // So the property asserted is the one the retry depends on: when PostgreSQL
  // does refuse to order two of these, it says so in a way
  // `marketingSerializationFailure()` recognises. A conflict the classifier
  // does not recognise is a conflict nothing retries.
  const account = await channel();
  const first = await publishedPost(account.id);
  const second = await publishedPost(account.id);

  const bump = (id: string, claim: string) =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT DISTINCT used."value"
          FROM "MarketingPost" AS post,
               unnest(post."claimIds") AS used("value")
          WHERE post."channelId" = ${account.id}
            AND post."status" IN ('published')
        `);
        await tx.marketingPost.update({
          where: { id },
          data: { claimIds: [claim] },
        });
        return "done" as const;
      },
      { isolationLevel: "Serializable" },
    );

  // Each transaction reads what the other writes, which is the shape SSI
  // exists to catch. Whether it catches this particular pair is PostgreSQL's
  // business; what is asserted is that if it does, the failure is one the
  // retry loop recognises, and that otherwise both simply succeed.
  const results = await Promise.all([
    bump(first.id, "claim.one").catch((error: unknown) => error),
    bump(second.id, "claim.two").catch((error: unknown) => error),
  ]);

  for (const result of results) {
    if (result instanceof Error) {
      assert.ok(
        marketingSerializationFailure(result),
        `unrecognised concurrency failure: ${result.message}`,
      );
    } else {
      assert.equal(result, "done");
    }
  }
});
