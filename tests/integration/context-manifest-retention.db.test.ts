import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  MANIFEST_DETAIL_RETENTION_DAYS,
  MANIFEST_DETAIL_RETENTION_MS,
  compactAgedContextManifests,
  oldestUncompactedManifestAgeDays,
} from "@/lib/routingManifestRetention";

/**
 * MANIFEST-02 — deletion first, then aged detail.
 *
 * Two claims, and only the second is a job. Deletion is structural: a manifest
 * hangs off an attempt, which hangs off a run, which cascades from the
 * account. What a database can establish here is that the structural half
 * really is immediate -- that a fresh manifest well inside its retention
 * window goes the moment the account does -- and that the job half drops the
 * detail without ever making a compacted record look like a request that
 * described nothing.
 */

const DAY = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-08-13T00:00:00.000Z");

const resetData = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "RoutingRun" RESTART IDENTITY CASCADE`);

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

const seedManifest = async (options: { ageDays: number; userId?: string | null }) => {
  const createdAt = new Date(NOW.getTime() - options.ageDays * DAY);
  const run = await prisma.routingRun.create({
    data: {
      mode: "manual",
      traceId: `trace-${randomUUID()}`,
      userId: options.userId ?? null,
      subjectKey: `subject-${randomUUID()}`,
      plan: "Pro",
      taskProfileVersion: "manual",
      candidateFilterVersion: "manual",
      selectionVersion: "manual",
      estimatorVersion: "generic_multilingual_v1",
      profileKind: "manual",
      profileConfidence: "none",
      needsCurrentInformation: false,
      hasImageInput: false,
      hasDocumentInput: false,
      expectedOutputLength: "medium",
      estimatedInputTokens: 1_000,
      reservedInputTokens: 1_200,
      requestOutputCapTokens: 4_000,
      eligibleCount: 1,
      rejectedByReason: {},
      selectionReason: "only_candidate",
      selectionMargin: 0,
      userSelectedModelId: "gpt-5-6-luna",
      decisionMicros: 0,
    },
    select: { id: true },
  });
  const attempt = await prisma.routingAttempt.create({
    data: {
      runId: run.id,
      userId: options.userId ?? null,
      attemptIndex: 0,
      modelId: "gpt-5-6-luna",
      provider: "openai",
    },
    select: { id: true },
  });
  const manifest = await prisma.contextManifest.create({
    data: {
      attemptId: attempt.id,
      userId: options.userId ?? null,
      sourceRefs: [{ role: "user", index: 0, parts: [{ kind: "text", bytes: 42 }] }],
      inclusionRange: { from: 0, to: 4 },
      truncationPoints: [{ messageIndex: 2 }],
      tokenizerVersion: "generic_multilingual_v1",
      tokenCount: 1_200,
      contextWindowTokens: 128_000,
      createdAt,
    },
    select: { id: true },
  });
  return { runId: run.id, manifestId: manifest.id };
};

test("the retention window is the gate's stated ceiling, not something under it", () => {
  assert.equal(MANIFEST_DETAIL_RETENTION_DAYS, 90);
  assert.equal(MANIFEST_DETAIL_RETENTION_MS, 90 * DAY);
});

test("a manifest inside the window keeps every part of its detail", async () => {
  const { manifestId } = await seedManifest({ ageDays: 89 });

  const result = await compactAgedContextManifests(NOW);
  assert.equal(result.compacted, 0);

  const manifest = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: manifestId },
  });
  assert.equal(manifest.compactedAt, null);
  assert.equal(Array.isArray(manifest.sourceRefs), true);
  assert.notEqual(manifest.inclusionRange, null);
});

// The split is by what each half lets somebody do: the hash still proves the
// request, the references still described it.
test("an aged manifest loses what described the request and keeps what proves it", async () => {
  const { manifestId } = await seedManifest({ ageDays: 91 });
  await prisma.contextManifest.update({
    where: { id: manifestId },
    data: {
      state: "finalized",
      finalizedAt: new Date(NOW.getTime() - 91 * DAY),
      plannerVersion: "none",
      adapterVersion: "vercel-ai-sdk-streamText-v1",
      effectiveRequestHash: "a".repeat(64),
    },
  });

  const result = await compactAgedContextManifests(NOW);
  assert.equal(result.compacted, 1);
  assert.equal(result.remaining, 0);

  const manifest = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: manifestId },
  });
  assert.deepEqual(manifest.sourceRefs, []);
  assert.equal(manifest.inclusionRange, null);
  assert.equal(manifest.truncationPoints, null);
  assert.notEqual(manifest.compactedAt, null);

  // What an audit verifies with survives intact.
  assert.equal(manifest.effectiveRequestHash, "a".repeat(64));
  assert.equal(manifest.adapterVersion, "vercel-ai-sdk-streamText-v1");
  assert.equal(manifest.tokenizerVersion, "generic_multilingual_v1");
  assert.equal(manifest.tokenCount, 1_200);
  assert.equal(manifest.contextWindowTokens, 128_000);
});

// Without the marker a compacted manifest would be indistinguishable from a
// dispatch whose request had no source parts -- a false record of a real one.
test("a compacted manifest cannot be read as one that described nothing", async () => {
  const { manifestId } = await seedManifest({ ageDays: 120 });
  await compactAgedContextManifests(NOW);

  const compacted = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: manifestId },
  });
  assert.notEqual(compacted.compactedAt, null);

  // And the database refuses the two halves apart, in both directions.
  const fresh = await seedManifest({ ageDays: 1 });
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: fresh.manifestId },
      data: { compactedAt: NOW },
    }),
    /compacted_has_no_detail_check/,
    "a manifest was marked compacted while still holding its detail"
  );
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: fresh.manifestId },
      data: {
        sourceRefs: [],
        inclusionRange: Prisma.DbNull,
        truncationPoints: Prisma.DbNull,
        compactedAt: NOW,
      },
    }).then(() =>
      prisma.contextManifest.update({
        where: { id: fresh.manifestId },
        data: { sourceRefs: [{ role: "user", index: 0, parts: [] }] },
      })
    ),
    /compacted_has_no_detail_check/,
    "detail was written back onto a compacted manifest"
  );
});

// The immutability trigger refused every update to a finalized manifest, and
// ROUTE-06's boundary rests on that. Retention needed one lossy transition
// through it, so the wall got a door of exactly that shape. These are the
// things that must still be refused, or compaction became a tampering hole.
test("compaction is the only edit a finalized manifest accepts", async (t) => {
  const { manifestId } = await seedManifest({ ageDays: 100 });
  const finalized = {
    state: "finalized",
    finalizedAt: new Date(NOW.getTime() - 100 * DAY),
    plannerVersion: "none",
    adapterVersion: "vercel-ai-sdk-streamText-v1",
    effectiveRequestHash: "b".repeat(64),
  };
  await prisma.contextManifest.update({ where: { id: manifestId }, data: finalized });

  const refused = async (label: string, data: Record<string, unknown>) => {
    await assert.rejects(
      prisma.contextManifest.update({ where: { id: manifestId }, data }),
      /only retention compaction may modify it/,
      label
    );
  };

  await refused("the effective-request hash was rewritten", {
    effectiveRequestHash: "c".repeat(64),
  });
  await refused("the token count was rewritten", { tokenCount: 1 });
  await refused("the adapter version was rewritten", { adapterVersion: "other" });
  await refused("the window it was checked against was rewritten", {
    contextWindowTokens: 8,
  });
  // Dropping detail without saying so is the half that would make a compacted
  // manifest read as one that described nothing.
  await refused("detail was dropped without the marker", {
    sourceRefs: [],
    inclusionRange: null,
    truncationPoints: null,
  });
  await refused("the marker was set while the detail stayed", { compactedAt: NOW });

  // The one permitted transition still works.
  await compactAgedContextManifests(NOW);
  const compacted = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: manifestId },
  });
  assert.notEqual(compacted.compactedAt, null);
  assert.equal(compacted.effectiveRequestHash, "b".repeat(64));

  // And it is not a door that stays open: a compacted row cannot be edited
  // again, un-compacted, or given its detail back.
  await refused("a compacted manifest was compacted again", { compactedAt: NOW });
  await refused("a compacted manifest was returned to uncompacted", {
    compactedAt: null,
  });
  await refused("detail was written back onto a compacted manifest", {
    sourceRefs: [{ role: "user", index: 0, parts: [] }],
  });
  t.diagnostic("the wall has one door, and it opens once");
});

test("compacting twice does not recount a row already compacted", async () => {
  await seedManifest({ ageDays: 100 });

  assert.equal((await compactAgedContextManifests(NOW)).compacted, 1);
  assert.equal((await compactAgedContextManifests(NOW)).compacted, 0);
});

// A backlog is worked through over several runs rather than in one statement
// that holds locks while a chat request waits behind it.
test("a batch is bounded and reports what it did not reach", async () => {
  for (let index = 0; index < 3; index += 1) {
    await seedManifest({ ageDays: 100 + index });
  }

  const first = await compactAgedContextManifests(NOW, 2);
  assert.equal(first.compacted, 2);
  assert.equal(first.remaining, 1);

  const second = await compactAgedContextManifests(NOW, 2);
  assert.equal(second.compacted, 1);
  assert.equal(second.remaining, 0);
});

// §5: deletion always takes priority over audit retention. A manifest well
// inside its window goes the moment the account does -- the job never gets a
// say, and never gets a chance to hold one back.
test("deleting the account takes a manifest that has not aged at all", async () => {
  const user = await prisma.user.create({
    data: { email: `manifest-retention-${randomUUID()}@example.test` },
  });
  const { manifestId } = await seedManifest({ ageDays: 0, userId: user.id });

  await prisma.user.delete({ where: { id: user.id } });

  assert.equal(
    await prisma.contextManifest.findUnique({ where: { id: manifestId } }),
    null
  );
});

// The second MANIFEST-02 metric, and the distinction that makes it readable:
// nothing uncompacted is a pass, not a missing measurement.
test("the oldest uncompacted age is a number, or null for nothing to report", async () => {
  assert.equal(await oldestUncompactedManifestAgeDays(NOW), null);

  await seedManifest({ ageDays: 30 });
  const age = await oldestUncompactedManifestAgeDays(NOW);
  assert.ok(age !== null && Math.abs(age - 30) < 0.01);

  await seedManifest({ ageDays: 200 });
  await compactAgedContextManifests(NOW);
  // The 200-day row is compacted; the 30-day one is still inside its window.
  const afterSweep = await oldestUncompactedManifestAgeDays(NOW);
  assert.ok(afterSweep !== null && Math.abs(afterSweep - 30) < 0.01);
  assert.ok(afterSweep <= MANIFEST_DETAIL_RETENTION_DAYS);
});
