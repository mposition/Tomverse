import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  MANIFEST_DETAIL_RETENTION_DAYS,
  MANIFEST_DETAIL_RETENTION_MS,
  compactAgedContextManifests,
  compactionPatch,
  MANIFEST_COMPACTION_CLEARS,
  MANIFEST_COMPACTION_KEEPS,
  MANIFEST_COMPACTION_TARGET_MS,
  compactManifestsForMemoryChange,
  manifestRetentionMetrics,
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

  // And the database refuses the two halves apart. The reason travels with
  // the marker, so this supplies it and lets the detail rule be the one that
  // fires -- a case that named two constraints would pass on either.
  const fresh = await seedManifest({ ageDays: 1 });
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: fresh.manifestId },
      data: { compactedAt: NOW, compactionReason: "aged" },
    }),
    /compacted_has_no_detail_check/,
    "a manifest was marked compacted while still holding its detail"
  );

  await prisma.contextManifest.update({
    where: { id: fresh.manifestId },
    data: compactionPatch(NOW, "aged"),
  });
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: fresh.manifestId },
      data: { sourceRefs: [{ role: "user", index: 0, parts: [] }] },
    }),
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

// A snapshot of "oldest uncompacted" forgets its own violations: a row that
// sat at ninety-five days and was then compacted vanishes from it. A
// compliance metric that erases breaches is not one.
test("retention is measured on both sides, and breaches are counted", async () => {
  const empty = await manifestRetentionMetrics(NOW);
  assert.equal(empty.violations, 0);
  assert.equal(empty.worstCompletedRetentionMs, null);
  assert.equal(empty.worstOpenRetentionMs, null);

  // One row compacted late -- the case a snapshot would lose.
  const late = await seedManifest({ ageDays: 95 });
  await prisma.contextManifest.update({
    where: { id: late.manifestId },
    data: compactionPatch(NOW, "aged"),
  });
  // One row still holding detail, inside the window.
  await seedManifest({ ageDays: 10 });

  const metrics = await manifestRetentionMetrics(NOW);
  assert.equal(metrics.compactedRows, 1);
  assert.equal(metrics.detailedRows, 1);
  assert.ok(
    metrics.worstCompletedRetentionMs !== null &&
      metrics.worstCompletedRetentionMs > MANIFEST_DETAIL_RETENTION_MS,
    "a late compaction was not recorded as one"
  );
  assert.equal(metrics.violations, 1, "the breach was forgotten once compacted");

  const openMs = metrics.worstOpenRetentionMs;
  assert.ok(openMs !== null && Math.abs(openMs - 10 * DAY) < 1_000);
});

// Flooring to days is how 90.9 becomes 90 and a violation becomes a pass.
test("a row past the ceiling by hours is a violation, not a rounded pass", async () => {
  const { manifestId } = await seedManifest({ ageDays: 90 });
  await prisma.contextManifest.update({
    where: { id: manifestId },
    data: { createdAt: new Date(NOW.getTime() - MANIFEST_DETAIL_RETENTION_MS - 3 * 60 * 60 * 1_000) },
  });

  const metrics = await manifestRetentionMetrics(NOW);
  assert.equal(metrics.violations, 1);
});

// The sweep targets the ceiling minus one run of the schedule, so a daily
// sweep never leaves a row sitting past ninety for a whole cycle.
test("the sweep compacts before the ceiling, by one sweep interval", async () => {
  assert.ok(MANIFEST_COMPACTION_TARGET_MS < MANIFEST_DETAIL_RETENTION_MS);
  await seedManifest({ ageDays: 89.5 });

  const result = await compactAgedContextManifests(NOW);
  assert.equal(result.compacted, 1, "a row inside the headroom was left for another day");
  assert.equal((await manifestRetentionMetrics(NOW)).violations, 0);
});

// §5: memory deletion and supersession outrank the retention window. Nothing
// links a manifest to a memory item, so the scope is the account's detailed
// manifests -- more than strictly necessary, which is the side to err on when
// the policy says this outranks retention.
test("a memory deletion compacts the account's detail without waiting", async () => {
  const user = await prisma.user.create({
    data: { email: `memory-change-${randomUUID()}@example.test` },
  });
  const mine = await seedManifest({ ageDays: 1, userId: user.id });
  const someoneElse = await seedManifest({ ageDays: 1 });

  const count = await compactManifestsForMemoryChange(user.id, "memory_deleted", NOW);
  assert.equal(count, 1);

  const compacted = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: mine.manifestId },
  });
  assert.equal(compacted.compactionReason, "memory_deleted");
  assert.deepEqual(compacted.sourceRefs, []);

  // Another account's manifest is untouched: this is a privacy transition for
  // one person, not a sweep.
  const untouched = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: someoneElse.manifestId },
  });
  assert.equal(untouched.compactedAt, null);
});

test("supersession is recorded as itself, not folded into deletion", async () => {
  const user = await prisma.user.create({
    data: { email: `memory-supersede-${randomUUID()}@example.test` },
  });
  const { manifestId } = await seedManifest({ ageDays: 1, userId: user.id });

  await compactManifestsForMemoryChange(user.id, "memory_superseded", NOW);
  const manifest = await prisma.contextManifest.findUniqueOrThrow({
    where: { id: manifestId },
  });
  assert.equal(manifest.compactionReason, "memory_superseded");
});

// The allowlist is the mechanism: a column added later that carries a message
// id or a summary label would keep being written past the window simply
// because nobody thought to clear it.
test("every manifest column is on exactly one side of the compaction split", async () => {
  const columns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ContextManifest'
  `;
  const named = new Set<string>([
    ...MANIFEST_COMPACTION_KEEPS,
    ...MANIFEST_COMPACTION_CLEARS,
  ]);
  const unclassified = columns
    .map((row) => row.column_name)
    .filter((name) => !named.has(name));

  assert.deepEqual(
    unclassified,
    [],
    "a manifest column belongs to neither the kept nor the cleared list"
  );
});

// A reason with nothing compacted is a claim about an event that did not
// happen, and a compaction with no reason is a record nobody can audit.
test("the compaction marker and its reason are stored together", async () => {
  const { manifestId } = await seedManifest({ ageDays: 1 });
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: manifestId },
      data: { compactionReason: "aged" },
    }),
    /compaction_reason_pair_check/
  );
});

test("a compaction reason nobody enumerated is refused", async () => {
  const { manifestId } = await seedManifest({ ageDays: 1 });
  await assert.rejects(
    prisma.contextManifest.update({
      where: { id: manifestId },
      data: {
        sourceRefs: [],
        inclusionRange: Prisma.DbNull,
        truncationPoints: Prisma.DbNull,
        summaryVersion: null,
        compactedAt: NOW,
        compactionReason: "because",
      },
    }),
    /compactionReason_check/
  );
});
