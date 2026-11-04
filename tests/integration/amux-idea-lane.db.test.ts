import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { AMUX_IDEA_LANE_MAX_ATTEMPTS, AMUX_IDEA_LANE_PUBLISH_FENCE_MS } from "@/lib/amux/ideaLaneCore";
import { createInitialIdeaOnlySourcePlan } from "@/lib/amux/ideaInitialSourcePlanService";
import { amuxIdeaLaneTook, claimAmuxIdeaLane, fenceAmuxIdeaLanePublish, observeAmuxIdeaLaneMerges,
  recordAmuxIdeaLaneResult } from "@/lib/amux/ideaLaneService";
import { EngineeringAgentGitHubReadError } from "@/lib/engineeringAgentGitHubRead";
import { readAmuxIdeaProgressForOwner } from "@/lib/amux/ideaProgressRead";
import { prisma } from "@/lib/prisma";

// The idea lane's claim and result against PostgreSQL (lib/amux/ideaLaneService.ts).
// No content key store exists here, so every claimed idea fails to open: the
// claim then records the run as job_failed, which is exactly the path that
// counts toward the attempt limit.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

const DAY_MS = 86_400_000;


const OWNER_PREFIX = "idea-lane-";
// Each claim is scoped to its test's owner, so no other suite's idea is
// touched; each test removes its own ideas when it ends.
const OLD = Date.now() - 6 * DAY_MS;
const removeIdeas = async () => {
  const where = { actorUserId: { startsWith: OWNER_PREFIX } };
  await prisma.amuxIdeaAnalysisChunk.deleteMany({ where });
  await prisma.amuxIdeaSubmission.deleteMany({ where });
};

before(async () => {
  process.env.AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY = "100";
  await removeIdeas();
});

after(async () => {
  await removeIdeas();
  await prisma.$disconnect();
});

const seedIdea = async (actorUserId: string, submittedAt: Date) => {
  const id = randomUUID();
  await prisma.amuxIdeaSubmission.create({
    data: {
      id, requestId: randomUUID(), actorUserId, state: "submitted", submittedAt,
      analysisDeadlineAt: new Date(submittedAt.getTime() + 7 * DAY_MS), rawPurgeAfter: new Date(submittedAt.getTime() + 7 * DAY_MS),
      rawCiphertext: new Uint8Array([1, 2, 3]), rawKeyId: "test-key", rawKeyVersion: 1,
      rawDigest: "a".repeat(64), rawDigestKeyId: "test-digest",
    },
  });
  return id;
};
const attemptsOf = (ideaId: string) => prisma.amuxIdeaLaneAttempt.findMany({ where: { ideaId }, orderBy: { claimedAt: "asc" } });

test("an idea is tried up to the attempt limit and then left alone", async () => {
  const owner = `${OWNER_PREFIX}${randomUUID()}`;
  const idea = await seedIdea(owner, new Date(OLD));
  for (let index = 0; index < AMUX_IDEA_LANE_MAX_ATTEMPTS + 1; index += 1) {
    assert.equal(await claimAmuxIdeaLane({ actorUserId: owner }), null, "an idea that cannot be opened is never handed out");
  }
  const attempts = await attemptsOf(idea);
  assert.equal(attempts.length, AMUX_IDEA_LANE_MAX_ATTEMPTS);
  assert.ok(attempts.every((row) => row.outcome === "job_failed" && row.finishedAt !== null && row.prNumber === null));
  const [row] = await readAmuxIdeaProgressForOwner(owner);
  assert.equal(row.lane?.state, "failed");
  assert.equal(row.attention, true);
  assert.equal(row.closable, true);
  await removeIdeas();
});

test("ideas the lane is done with never crowd out a new one, and an idea already in analysis is not taken", async () => {
  const owner = `${OWNER_PREFIX}${randomUUID()}`;
  const base = OLD;
  const done: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    const id = await seedIdea(owner, new Date(base + index * 1_000));
    done.push(id);
    const claimedAt = new Date(base + index * 1_000 + 500);
    await prisma.amuxIdeaLaneAttempt.create({ data: { id: randomUUID(), ideaId: id, claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + 60_000), finishedAt: claimedAt, outcome: "pr_open", prNumber: 4000 + index } });
  }
  const analysed = await seedIdea(owner, new Date(base + 31_000));
  await prisma.amuxIdeaAnalysisChunk.create({
    data: { ideaId: analysed, actorUserId: owner, chunkIndex: 0, state: "awaiting_preview", attempt: 0, leaseGeneration: 0 },
  });
  const fresh = await seedIdea(owner, new Date(base + 32_000));

  await claimAmuxIdeaLane({ actorUserId: owner });
  assert.equal((await attemptsOf(fresh)).length, 1, "the new idea is claimed past 25 finished ones");
  assert.equal((await attemptsOf(analysed)).length, 0, "an owner idea whose analysis started stays on that path");
  for (const id of done) assert.equal((await attemptsOf(id)).length, 1);

  const rows = await readAmuxIdeaProgressForOwner(owner);
  const opened = rows.find((row) => row.ideaId === done[24]);
  assert.equal(opened?.stage, "review");
  assert.deepEqual(opened?.reviewPullRequests, [{ number: 4024, displayKey: null }]);
  await removeIdeas();
});

test("a run's result is recorded once, and the table refuses an unknown outcome", async () => {
  const owner = `${OWNER_PREFIX}${randomUUID()}`;
  const idea = await seedIdea(owner, new Date(OLD));
  const attemptId = randomUUID();
  const now = new Date();
  await prisma.amuxIdeaLaneAttempt.create({ data: { id: attemptId, ideaId: idea, claimedAt: now,
    leaseUntil: new Date(now.getTime() + 60_000) } });
  assert.equal((await readAmuxIdeaProgressForOwner(owner))[0].lane?.state, "running");
  assert.equal(await claimAmuxIdeaLane({ actorUserId: owner }), null);
  assert.equal((await attemptsOf(idea)).length, 1, "never a second run beside a live one");

  assert.equal(await recordAmuxIdeaLaneResult({ attemptId, outcome: "pr_open", prNumber: 77 }), true);
  assert.equal(await recordAmuxIdeaLaneResult({ attemptId, outcome: "no_change", prNumber: null }), false, "a replay is not applied");
  assert.equal(await recordAmuxIdeaLaneResult({ attemptId: randomUUID(), outcome: "no_change", prNumber: null }), false);
  const [row] = await attemptsOf(idea);
  assert.equal(row.outcome, "pr_open");
  assert.equal(row.prNumber, 77);

  await assert.rejects(prisma.amuxIdeaLaneAttempt.create({ data: { id: randomUUID(), ideaId: idea, claimedAt: now,
    leaseUntil: now, finishedAt: now, outcome: "merged" } }));
  await assert.rejects(prisma.amuxIdeaLaneAttempt.create({ data: { id: randomUUID(), ideaId: idea, claimedAt: now,
    leaseUntil: now, prNumber: 5 } }), "a run still going carries no PR number");
  await removeIdeas();
});

test("an idea the lane took never starts the analysis path as well", async () => {
  const owner = `${OWNER_PREFIX}${randomUUID()}`;
  const idea = await seedIdea(owner, new Date(OLD));
  await claimAmuxIdeaLane({ actorUserId: owner });
  assert.equal((await attemptsOf(idea)).length, 1);
  await assert.rejects(prisma.$transaction((tx) => createInitialIdeaOnlySourcePlan(tx,
    { ideaId: idea, actorUserId: owner, keys: {} as never })), { message: "not_ready" });
  await removeIdeas();
});

test("a run may publish only while its idea is open and its lease live, and the fence holds a close off", async () => {
  const owner = `${OWNER_PREFIX}${randomUUID()}`;
  const idea = await seedIdea(owner, new Date(OLD));
  const now = Date.now();
  const make = async (leaseMs: number, outcome?: "no_change") => {
    const id = randomUUID();
    await prisma.amuxIdeaLaneAttempt.create({ data: { id, ideaId: idea, claimedAt: new Date(now - 1_000),
      leaseUntil: new Date(now + leaseMs), ...(outcome ? { outcome, finishedAt: new Date(now) } : {}) } });
    return id;
  };
  assert.equal(await fenceAmuxIdeaLanePublish(randomUUID()), false, "an unknown run");
  assert.equal(await fenceAmuxIdeaLanePublish(await make(-1_000)), false, "a lapsed lease: a retry may be running");
  assert.equal(await fenceAmuxIdeaLanePublish(await make(60_000, "no_change")), false, "a finished run");
  const live = await make(5_000);
  assert.equal(await fenceAmuxIdeaLanePublish(live), true);
  const { leaseUntil } = await prisma.amuxIdeaLaneAttempt.findUniqueOrThrow({ where: { id: live } });
  assert.ok(leaseUntil.getTime() - now >= AMUX_IDEA_LANE_PUBLISH_FENCE_MS - 5_000,
    "the lease now outlasts the publish job");
  await prisma.amuxIdeaSubmission.update({ where: { id: idea },
    data: { state: "cancelled", cancelledAt: new Date(), rawPurgeAfter: new Date() } });
  assert.equal(await fenceAmuxIdeaLanePublish(live), false, "a closed idea is never published");
  await removeIdeas();
});

test("the PR observer records how a lane PR ended, once, only for the run's own branch into develop", async () => {
  const owner = `${OWNER_PREFIX}${randomUUID()}`;
  const now = new Date();
  const open = async (prNumber: number) => {
    const ideaId = await seedIdea(owner, new Date(OLD + prNumber));
    const id = randomUUID();
    await prisma.amuxIdeaLaneAttempt.create({ data: { id, ideaId, claimedAt: now, leaseUntil: now,
      finishedAt: now, outcome: "pr_open", prNumber } });
    return { ideaId, id };
  };
  const merged = await open(9_000_001);
  const waiting = await open(9_000_002);
  const foreign = await open(9_000_003);
  const unreadable = await open(9_000_004);
  const closed = await open(9_000_005);
  const mergedAt = new Date("2026-11-03T23:52:28Z");
  type Pull = { state: "open" | "closed"; merged: boolean; mergedAt: Date | null; baseRef: string; headRef: string };
  const pulls: Record<number, Pull> = {
    9_000_001: { state: "closed", merged: true, mergedAt, baseRef: "develop", headRef: `amux-idea/${merged.id}` },
    9_000_002: { state: "open", merged: false, mergedAt: null, baseRef: "develop", headRef: `amux-idea/${waiting.id}` },
    9_000_003: { state: "closed", merged: true, mergedAt, baseRef: "develop", headRef: "someone/else" },
    9_000_005: { state: "closed", merged: false, mergedAt: null, baseRef: "develop", headRef: `amux-idea/${closed.id}` },
  };
  const read = async (prNumber: number) => {
    const pull = pulls[prNumber];
    if (!pull) throw new EngineeringAgentGitHubReadError("http_error");
    return pull;
  };
  const outcomes = new Map((await observeAmuxIdeaLaneMerges(read)).map((row) => [row.attemptId, row.outcome]));
  assert.equal(outcomes.get(merged.id), "merged");
  assert.equal(outcomes.get(waiting.id), "waiting");
  assert.equal(outcomes.get(foreign.id), "not_the_lane_pr", "a number that is not this run's branch decides nothing");
  assert.equal(outcomes.get(unreadable.id), "unreadable");
  assert.equal(outcomes.get(closed.id), "closed");
  const stored = await prisma.amuxIdeaLaneAttempt.findMany({
    where: { id: { in: [merged.id, waiting.id, foreign.id, closed.id] } } });
  assert.deepEqual(stored.filter((row) => row.mergedAt !== null).map((row) => [row.id, row.mergedAt?.toISOString()]),
    [[merged.id, mergedAt.toISOString()]]);
  assert.deepEqual(stored.filter((row) => row.prClosedAt !== null).map((row) => row.id), [closed.id]);
  const again = new Set((await observeAmuxIdeaLaneMerges(read)).map((row) => row.attemptId));
  assert.ok(!again.has(merged.id) && !again.has(closed.id), "an ended PR is not read again");
  assert.ok(again.has(waiting.id), "an open one still is");

  const rows = await readAmuxIdeaProgressForOwner(owner);
  const done = rows.find((row) => row.ideaId === merged.ideaId);
  assert.equal(done?.stage, "done");
  assert.equal(done?.lane?.state, "merged");
  assert.equal(done?.closable, false, "a merged idea has nothing left to close");
  assert.deepEqual(done?.reviewPullRequests, []);
  assert.equal(rows.find((row) => row.ideaId === waiting.ideaId)?.stage, "review");
  const shut = rows.find((row) => row.ideaId === closed.ideaId);
  assert.deepEqual([shut?.stage, shut?.attention, shut?.closable, shut?.lane?.state], ["review", true, true, "pr_closed"]);
  assert.equal(await amuxIdeaLaneTook(merged.ideaId), true);
  assert.equal(await amuxIdeaLaneTook(await seedIdea(owner, new Date(OLD))), false);

  await assert.rejects(prisma.amuxIdeaLaneAttempt.create({ data: { id: randomUUID(), ideaId: merged.ideaId,
    claimedAt: now, leaseUntil: now, finishedAt: now, outcome: "no_change", mergedAt } }),
    "only an opened PR can merge");
  await assert.rejects(prisma.amuxIdeaLaneAttempt.update({ where: { id: merged.id }, data: { prClosedAt: now } }),
    "a PR ends one way");
  await removeIdeas();
});
