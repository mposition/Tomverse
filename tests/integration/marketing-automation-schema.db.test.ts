import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { Prisma } from "@prisma/client";

import { MARKETING_CHANNEL_CAPS } from "@/lib/marketingAutomationSchema";
import {
  createMarketingChannel,
  createMarketingPost,
  insertAiVisibilityRun,
  insertMarketingReport,
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

const refused = async (operation: Promise<unknown>, expected: RegExp) => {
  await assert.rejects(operation, (error: Error) => {
    assert.match(error.message, expected);
    return true;
  });
};

beforeEach(reset);

after(async () => {
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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `CREATE TEMPORARY TABLE "MarketingChannel" ("id" TEXT, "channel" TEXT, "allowedLocales" TEXT[]) ON COMMIT DROP`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO pg_temp."MarketingChannel" VALUES ($1, 'linkedin', ARRAY['en'])`,
      instagram.id,
    );
    await refused(
      tx.marketingPost.create({
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
      }),
      /cannot be autonomous on instagram/,
    );
  });
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
  const row = await channel();
  await refused(
    prisma.$executeRawUnsafe(
      `UPDATE "MarketingChannel" SET "accountSlug" = 'tiktok-1' WHERE "id" = $1`,
      row.id,
    ),
    /slug is immutable|accountSlug_shape/,
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

test("the store's create writes the draft entry itself", async () => {
  const row = await approvedChannel();
  const created = await createMarketingPost(prisma, {
    channelId: row.id,
    locale: "en",
    kind: "social",
    logicalKey: "store-created-1",
    envelope: envelope() as never,
    envelopeDigest: DIGEST,
    rendererVersion: "r1",
    templateId: null,
    templateDigest: null,
    claimIds: [],
    assetIds: [],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshot: factSnapshot as never,
    guardDecision: "approval_required",
    guardCodes: [],
    guardRuleIds: [],
    status: "drafted",
    mode: "approval",
    draftedAt: new Date(),
  });
  assert.equal(created.historyVersion, 0);
  assert.equal((created.history as { type: string }[]).length, 1);
});

test("a dispatched post cannot go back to a state that says it never left", async () => {
  const row = await approvedChannel();
  const dispatched = await post(row.id);
  await prisma.marketingPost.update({
    where: { id: dispatched.id },
    data: { status: "pending_approval", historyVersion: 1, history: [
      ...(dispatched.history as Prisma.InputJsonValue[]),
      historyEntry("guard_result", { decision: "approval_required", codes: [], ruleIds: [] }),
    ] },
  });

  await refused(
    prisma.marketingPost.update({
      where: { id: dispatched.id },
      data: { status: "published" },
    }),
    /cannot move from pending_approval to published/,
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

test("a publication time is written once", async () => {
  const row = await approvedChannel();
  const published = await agedPost(row.id, 1, {
    status: "publishing",
    publishAttempt: 1,
  });
  await prisma.marketingPost.update({
    where: { id: published.id },
    data: { providerRequestKey: published.logicalKey },
  });

  const first = new Date();
  await prisma.marketingPost.update({
    where: { id: published.id },
    data: { status: "published", publishedAt: first },
  });

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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await refused(
      tx.marketingPost.update({
        where: { id: fresh.id },
        data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
      }),
      /not yet twenty-four months old/,
    );
  });

  const held = await agedPost(row.id, 800, { legalHold: true });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await refused(
      tx.marketingPost.update({
        where: { id: held.id },
        data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
      }),
      /under legal hold/,
    );
  });

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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);

    await refused(
      tx.marketingPost.update({
        where: { id: created.id },
        data: {
          history: [summary, compaction],
          historyVersion: 1,
        },
      }),
      /cannot compact a draft entry at any age/,
    );

    await refused(
      tx.marketingPost.update({
        where: { id: created.id },
        data: {
          history: [draftEntry, summary, compaction],
          historyVersion: 1,
        },
      }),
      /cannot compact an entry younger than ninety days/,
    );

    await refused(
      tx.marketingPost.update({
        where: { id: created.id },
        data: {
          history: [draftEntry, youngAttempt, compaction],
          historyVersion: 1,
        },
      }),
      /without summarising them/,
    );

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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await refused(
      tx.marketingPost.delete({ where: { id: fresh.id } }),
      /not yet ninety days old/,
    );
  });

  const dispatched = await agedPost(row.id, 200, {
    status: "guard_rejected",
    guardDecision: "reject",
    publishAttempt: 1,
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await refused(
      tx.marketingPost.delete({ where: { id: dispatched.id } }),
      /reached a platform and is not deletable/,
    );
  });

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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(RETENTION_ON);
    await refused(
      tx.marketingReport.delete({ where: { id: report.id } }),
      /retained until/,
    );
  });
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
