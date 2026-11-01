import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  createMarketingChannel,
  evaluateMarketingAutoPause,
  runMarketingTransaction,
} from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const DIGEST = "c".repeat(64);
const MINUTE = 60_000;

const envelope = {
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Three models, three answers, side by side.",
  claimIds: [],
  assets: [],
  finalUrl: null,
  scheduledAt: null,
  disclosureFlags: ["advertising"],
};

beforeEach(async () => {
  await resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun", "MarketingLlmCall" RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await prisma.$disconnect();
});

async function approvalChannel() {
  const row = await createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
  return prisma.marketingChannel.update({ where: { id: row.id }, data: { status: "approval_mode" } });
}

type Attempt = { at: Date; attempt: number; outcome: "published" | "failed" | "outcome_unknown" };

/** A post whose history already holds the given attempt entries (the insert trigger is off for it). */
async function postWithAttempts(channelId: string, attempts: Attempt[], status = "failed") {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`,
  );
  try {
    return await prisma.marketingPost.create({
      data: {
        channelId,
        locale: "en",
        kind: "social",
        logicalKey: `post-${Math.random().toString(36).slice(2)}`,
        envelope,
        envelopeDigest: DIGEST,
        rendererVersion: "r1",
        claimIds: [],
        assetIds: [],
        claimRegistryVersion: 1,
        assetRegistryVersion: 1,
        factSnapshot: { priceRows: [], catalogue: null, modelRegistryRows: [], evidenceDigests: [] },
        factsDigest: DIGEST,
        guardDecision: "pass",
        guardCodes: [],
        guardRuleIds: [],
        status,
        mode: "approval",
        history: [
          { at: new Date().toISOString(), type: "draft", envelopeDigest: DIGEST },
          ...attempts.map((entry) => ({
            at: entry.at.toISOString(),
            type: "attempt",
            attempt: entry.attempt,
            outcome: entry.outcome,
            errorCode: entry.outcome === "published" ? null : "zernio_rejected",
          })),
        ],
        historyVersion: 0,
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`,
    );
  }
}

const evaluate = (channelId: string) =>
  runMarketingTransaction(prisma, (tx) => evaluateMarketingAutoPause(tx, { channelId }));

// Instants after the account's approval start, which the database set just now.
const at = (minutes: number) => new Date(Date.now() + (10 + minutes) * MINUTE);

test("three failed attempts stop the account, and the stop is audited with the trigger's own record of where it came from", async () => {
  const row = await approvalChannel();
  await postWithAttempts(row.id, [{ at: at(1), attempt: 1, outcome: "failed" }]);
  await postWithAttempts(row.id, [{ at: at(2), attempt: 1, outcome: "failed" }]);
  assert.equal((await evaluate(row.id)).paused, false);
  await postWithAttempts(row.id, [{ at: at(3), attempt: 1, outcome: "failed" }]);

  const result = await evaluate(row.id);
  assert.deepEqual(result, {
    paused: true,
    reasonCode: "consecutive_publish_failures",
    pausedFromMode: "approval_mode",
  });
  const stopped = await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.pauseReasonCode, "consecutive_publish_failures");
  assert.equal(stopped.pausedFromMode, "approval_mode");
  const audits = await prisma.adminAuditLog.findMany({
    where: { action: "marketing_account.auto_paused", targetId: row.id },
  });
  assert.equal(audits.length, 1);
  // A paused account is left alone by a second evaluation.
  assert.equal((await evaluate(row.id)).paused, false);
});

test("an unknown outcome settled as a failure later keeps the place of the attempt it belongs to", async () => {
  const row = await approvalChannel();
  // A was unknown at minute 1 and a person confirmed it failed at minute 9; B
  // published at 2, C and D failed at 3 and 4. The newest three attempts are
  // D, C, B -- a success among them -- however late A was settled.
  await postWithAttempts(row.id, [
    { at: at(1), attempt: 1, outcome: "outcome_unknown" },
    { at: at(9), attempt: 1, outcome: "failed" },
  ]);
  await postWithAttempts(row.id, [{ at: at(2), attempt: 1, outcome: "published" }], "published");
  await postWithAttempts(row.id, [{ at: at(3), attempt: 1, outcome: "failed" }]);
  await postWithAttempts(row.id, [{ at: at(4), attempt: 1, outcome: "failed" }]);

  assert.deepEqual(await evaluate(row.id), { paused: false });
  assert.equal((await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } })).status, "approval_mode");
});

test("a settled attempt is one attempt: three real failures still stop the account", async () => {
  const row = await approvalChannel();
  await postWithAttempts(row.id, [
    { at: at(1), attempt: 1, outcome: "outcome_unknown" },
    { at: at(5), attempt: 1, outcome: "failed" },
  ]);
  await postWithAttempts(row.id, [{ at: at(2), attempt: 1, outcome: "failed" }]);
  await postWithAttempts(row.id, [{ at: at(3), attempt: 1, outcome: "failed" }]);
  const result = await evaluate(row.id);
  assert.equal(result.paused, true);
});

test("an attempt made before the account's last fresh start is not evidence, however late it was settled", async () => {
  const row = await approvalChannel();
  const startedAt = (await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } })).approvalStartedAt;
  assert.ok(startedAt);
  const before = (minutes: number) => new Date(startedAt.getTime() - minutes * MINUTE);
  await postWithAttempts(row.id, [
    { at: before(3), attempt: 1, outcome: "outcome_unknown" },
    { at: at(1), attempt: 1, outcome: "failed" },
  ]);
  await postWithAttempts(row.id, [{ at: at(2), attempt: 1, outcome: "failed" }]);
  await postWithAttempts(row.id, [{ at: at(3), attempt: 1, outcome: "failed" }]);
  // Only two of the three were made after the start.
  assert.deepEqual(await evaluate(row.id), { paused: false });
});

test("a post whose attempts retention has summarised is not judged, so failures that were not consecutive do not become so", async () => {
  const row = await approvalChannel();
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`,
  );
  try {
    await prisma.marketingPost.create({
      data: {
        channelId: row.id,
        locale: "en",
        kind: "social",
        logicalKey: "compacted-1",
        envelope,
        envelopeDigest: DIGEST,
        rendererVersion: "r1",
        claimIds: [],
        assetIds: [],
        claimRegistryVersion: 1,
        assetRegistryVersion: 1,
        factSnapshot: { priceRows: [], catalogue: null, modelRegistryRows: [], evidenceDigests: [] },
        factsDigest: DIGEST,
        guardDecision: "pass",
        guardCodes: [],
        guardRuleIds: [],
        status: "failed",
        mode: "approval",
        history: [
          { at: new Date().toISOString(), type: "draft", envelopeDigest: DIGEST },
          {
            at: new Date().toISOString(),
            type: "retention_summary",
            summarises: "attempt",
            count: 2,
            firstAt: at(0).toISOString(),
            lastAt: at(1).toISOString(),
          },
          { at: at(3).toISOString(), type: "attempt", attempt: 3, outcome: "failed", errorCode: "zernio_rejected" },
        ],
        historyVersion: 0,
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`,
    );
  }
  await postWithAttempts(row.id, [{ at: at(4), attempt: 1, outcome: "failed" }]);
  await postWithAttempts(row.id, [{ at: at(5), attempt: 1, outcome: "failed" }]);
  assert.deepEqual(await evaluate(row.id), { paused: false });
});
