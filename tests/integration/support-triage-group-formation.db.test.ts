import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { groupCandidateKey, groupSnapshotDigest, OPEN_GROUP_SIGNAL_EXPIRES_AT } from "@/lib/supportTriageGroupCore";
import { startSupportTriageRun } from "@/lib/supportTriageRunStore";
import {
  claimSupportTriageBatch,
  readGroupPeers,
  runSupportTriageWorker,
  writeSupportTriageResults,
} from "@/lib/supportTriageWorker";

// New groups made by the worker's result transaction (policy section 6,
// design section 5.4). What needs a database: the reports are locked with
// their eligibility re-checked, the group key is unique (a live group or a
// tombstone stops a second one), a report is a member of one group at most,
// and a group left with fewer than two members must be emptied before it ends.

const PREFIX = "fb-gf-";

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageGroup"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.traceErrorEvidence.deleteMany({ where: { id: { startsWith: "ev-gf-" } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_delete"`);
  }
  await resetTestFixture(prisma, `TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

const report = (id: string, data: Record<string, unknown> = {}) =>
  prisma.feedback.create({ data: { id: `${PREFIX}${id}`, type: "bug", message: "The answer stops halfway.", ...data } });

/** A verified report linked to server evidence with the given error code. */
const verifiedReport = async (id: string, errorCode: string, data: Record<string, unknown> = {}) => {
  await prisma.traceErrorEvidence.create({
    data: {
      id: `ev-gf-${id}`,
      occurrenceId: `occ-gf-${id}`,
      traceId: `trace-gf-${id}`,
      traceProvenance: "server_generated",
      environment: "test",
      routeClass: "chat",
      release: "r1",
      errorCode,
      occurredAt: new Date("2026-10-01T00:00:00.000Z"),
    },
  });
  return report(id, { errorReportVerification: "verified", traceEvidenceId: `ev-gf-${id}`, ...data });
};

const groups = async () =>
  (
    await prisma.supportTriageGroup.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        primaryKind: true,
        state: true,
        primarySnapshotDigest: true,
        members: { select: { feedbackId: true }, orderBy: { feedbackId: "asc" } },
        signals: { select: { kind: true, snapshotExpiresAt: true }, orderBy: { kind: "asc" } },
      },
    })
  ).map((g) => ({
    kind: g.primaryKind,
    state: g.state,
    digest: g.primarySnapshotDigest,
    members: g.members.map((m) => m.feedbackId.slice(PREFIX.length)),
    signals: g.signals.map((s) => [s.kind, s.snapshotExpiresAt.toISOString()]),
  }));

const resultAudits = async () =>
  (await prisma.adminAuditLog.findMany({ where: { action: "support_triage.worker_result" }, select: { metadata: true } })).map(
    (row) => row.metadata as Record<string, number>
  );

/**
 * Resolves once some backend of this database is waiting on a lock, so a test
 * releases the other transaction only after the one under test is blocked.
 */
const waitUntilALockIsAwaited = async () => {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT pg_catalog.count(*)::integer AS "waiting" FROM pg_catalog.pg_stat_activity
       WHERE "datname" = pg_catalog.current_database() AND "wait_event_type" = 'Lock'`;
    if (row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the transaction under test never waited for a lock");
};

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("two reports from one account become one group with its account signal", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await report("guest1");
  await report("guest2");
  const result = await runSupportTriageWorker();
  assert.equal(result.ready, 4);
  assert.equal(result.groupsCreated, 1);
  assert.deepEqual(await groups(), [
    {
      kind: "same_account",
      state: "candidate",
      digest: groupSnapshotDigest("user-gf-1"),
      members: ["a", "b"],
      signals: [["same_account", OPEN_GROUP_SIGNAL_EXPIRES_AT.toISOString()]],
    },
  ]);
  const [audit] = await resultAudits();
  assert.equal(audit.groupsCreated, 1);
  assert.equal(audit.groupMembers, 2);
  assert.equal(audit.groupSignals, 1);
  // No account id, digest or report id reaches the audit log.
  const audits = JSON.stringify(await prisma.adminAuditLog.findMany({ select: { summary: true, metadata: true, targetId: true } }));
  for (const forbidden of ["user-gf-1", PREFIX, groupSnapshotDigest("user-gf-1")]) assert.ok(!audits.includes(forbidden), forbidden);
  // Settled: a further pass makes nothing new.
  const again = await runSupportTriageWorker();
  assert.equal(again.groupsCreated, 0);
  assert.equal((await groups()).length, 1);
});

test("the higher kind wins the shared report: {A,B,C} is never made", async () => {
  await report("A", { userId: "user-gf-1" });
  await verifiedReport("B", "AI_REQUEST_FAILED", { userId: "user-gf-1" });
  await verifiedReport("C", "AI_REQUEST_FAILED", { userId: "user-gf-2" });
  await runSupportTriageWorker();
  const made = await groups();
  assert.deepEqual(
    made.map((g) => [g.kind, g.members]),
    [["server_evidence_match", ["B", "C"]]]
  );
  // The evidence signal ends 30 days after the earliest occurrence.
  assert.deepEqual(made[0].signals, [["server_evidence_match", "2026-10-31T00:00:00.000Z"]]);
});

test("a report arriving later forms a group with an already-triaged peer", async () => {
  await report("a", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  assert.equal((await groups()).length, 0);
  await report("b", { userId: "user-gf-1" });
  // Only b is read as a candidate; a is found as its peer.
  const result = await runSupportTriageWorker();
  assert.equal(result.claimed, 1);
  assert.deepEqual(
    (await groups()).map((g) => g.members),
    [["a", "b"]]
  );
});

const onlyGroup = () =>
  prisma.supportTriageGroup.findFirstOrThrow({
    select: { id: true, state: true, groupCandidateKey: true, groupInputDigest: true },
  });

const fingerprintCase = (id: string, fingerprint: string) =>
  prisma.feedbackAutoFixCase.create({ data: { feedbackId: `${PREFIX}${id}`, traceId: `trace-gf-${id}`, fingerprint } });

test("a third report of a grouped account joins the group, which is rebound to its new members", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  const before = await onlyGroup();
  await report("c", { userId: "user-gf-1" });
  const result = await runSupportTriageWorker();
  assert.equal(result.groupsCreated, 0);
  assert.deepEqual(
    (await groups()).map((g) => [g.state, g.members]),
    [["candidate", ["a", "b", "c"]]]
  );
  const after = await onlyGroup();
  assert.equal(after.id, before.id);
  assert.equal(
    after.groupCandidateKey,
    groupCandidateKey({
      primaryKind: "same_account",
      primarySnapshotDigest: groupSnapshotDigest("user-gf-1"),
      memberIds: ["a", "b", "c"].map((id) => `${PREFIX}${id}`),
    })
  );
  assert.notEqual(after.groupInputDigest, before.groupInputDigest);
  const audit = (await resultAudits()).at(-1);
  assert.equal(audit?.groupsJoined, 1);
  assert.equal(audit?.joinedMembers, 1);
});

test("a newcomer that does not share a secondary value takes that signal off the group", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await fingerprintCase("a", "fp-1");
  await fingerprintCase("b", "fp-1");
  await runSupportTriageWorker();
  assert.deepEqual(
    (await groups())[0].signals.map((s) => s[0]),
    ["autofix_fingerprint", "same_account"]
  );
  await report("c", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  const [grown] = await groups();
  assert.deepEqual(grown.members, ["a", "b", "c"]);
  assert.deepEqual(
    grown.signals.map((s) => s[0]),
    ["same_account"]
  );
});

test("a confirmed group takes no new member; the newcomer waits and is counted", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  const { id } = await onlyGroup();
  await prisma.supportTriageGroup.update({
    where: { id },
    data: { state: "confirmed", decision: "confirmed", decidedAt: new Date() },
  });
  await report("c", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  assert.deepEqual(
    (await groups()).map((g) => [g.state, g.members]),
    [["confirmed", ["a", "b"]]]
  );
  assert.equal((await resultAudits()).at(-1)?.joinDeferred, 1);
});

test("a join whose grown member set is a tombstoned key is undone; the group keeps its members and key", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  const before = await onlyGroup();
  // A tombstone of exactly {a, b, c}, left by an earlier group.
  const digest = groupSnapshotDigest("user-gf-1");
  const tombstoneKey = groupCandidateKey({
    primaryKind: "same_account",
    primarySnapshotDigest: digest,
    memberIds: ["a", "b", "c"].map((id) => `${PREFIX}${id}`),
  });
  await prisma.supportTriageGroup.create({
    data: { id: "gf-tomb", primaryKind: "same_account", primarySnapshotDigest: digest, groupCandidateKey: tombstoneKey },
  });
  await prisma.supportTriageGroup.update({
    where: { id: "gf-tomb" },
    data: { state: "invalidated", primarySnapshotDigest: null },
  });
  await report("c", { userId: "user-gf-1" });
  const result = await runSupportTriageWorker();
  assert.equal(result.ready, 1);
  const after = await prisma.supportTriageGroup.findUniqueOrThrow({
    where: { id: before.id },
    select: { groupCandidateKey: true, groupInputDigest: true, members: { select: { feedbackId: true } } },
  });
  assert.equal(after.groupCandidateKey, before.groupCandidateKey);
  assert.equal(after.groupInputDigest, before.groupInputDigest);
  assert.deepEqual(after.members.map((m) => m.feedbackId).sort(), [`${PREFIX}a`, `${PREFIX}b`]);
  assert.equal(await prisma.supportTriageGroupMember.count({ where: { feedbackId: `${PREFIX}c` } }), 0);
  assert.equal((await resultAudits()).at(-1)?.joinsUndone, 1);
});

test("closed and deleted-account reports are never members", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("closed", { userId: "user-gf-1", status: "resolved" });
  await report("deleted", { userId: "user-gf-1", message: "[deleted account]" });
  assert.deepEqual(await readGroupPeers([`${PREFIX}a`]), [`${PREFIX}a`]);
  await runSupportTriageWorker();
  assert.equal((await groups()).length, 0);
});

test("a tombstoned key makes no second group for the same members", async () => {
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await runSupportTriageWorker();
  const [{ id }] = await prisma.supportTriageGroup.findMany({ select: { id: true } });
  // A person dismisses it: members, then signals, then the group.
  await prisma.supportTriageGroupMember.deleteMany({ where: { groupId: id } });
  await prisma.supportTriageGroupSignal.deleteMany({ where: { groupId: id } });
  await prisma.supportTriageGroup.update({
    where: { id },
    data: { state: "dismissed", decision: "dismissed", decidedAt: new Date(), primarySnapshotDigest: null },
  });
  // The reports are proposed again (their suggestions are gone).
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  const result = await runSupportTriageWorker();
  assert.equal(result.ready, 2);
  assert.equal(result.groupsCreated, 0);
  assert.deepEqual(
    (await groups()).map((g) => [g.state, g.members]),
    [["dismissed", []]]
  );
});

test("a group missing one planned member is emptied and invalidated, keeping every planned id; the batch still commits", async () => {
  // Three planned, one lost: two would remain, but the key names all three.
  await report("a", { userId: "user-gf-1" });
  await report("b", { userId: "user-gf-1" });
  await report("c", { userId: "user-gf-1" });
  await report("x");
  const run = await startSupportTriageRun("worker");
  const batch = await claimSupportTriageBatch(run, [`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`]);
  assert.equal(batch.claimed.length, 3);

  // Another transaction puts c in a group of its own and holds it uncommitted.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let inserted!: () => void;
  const ready = new Promise<void>((resolve) => (inserted = resolve));
  const other = prisma.$transaction(
    async (tx) => {
      await tx.supportTriageGroup.create({
        data: { id: "gf-other", primaryKind: "autofix_fingerprint", primarySnapshotDigest: "f".repeat(64), groupCandidateKey: "e".repeat(64) },
      });
      for (const feedbackId of [`${PREFIX}c`, `${PREFIX}x`]) {
        await tx.supportTriageGroupMember.create({
          data: { groupId: "gf-other", feedbackId, primarySnapshotDigest: "f".repeat(64) },
        });
      }
      inserted();
      await held;
    },
    { timeout: 30_000 }
  );
  await ready;
  // The result transaction plans {a, b, c}; inserting c waits on the other transaction.
  const writing = writeSupportTriageResults(run, batch.token as string, batch.claimed, { peerIds: [] });
  await waitUntilALockIsAwaited();
  release();
  await other;
  const result = await writing;
  assert.equal(result.ready, 3);
  assert.equal(result.groups.groupsCreated, 0);
  assert.equal(result.groups.groupsLost, 1);
  assert.equal(result.groups.groupMembers, 0);
  assert.equal(result.groups.groupSignals, 0);
  const made = await groups();
  assert.deepEqual(
    made.map((g) => [g.kind, g.state, g.digest === null, g.members]).sort(),
    [
      ["autofix_fingerprint", "candidate", false, ["c", "x"]],
      ["same_account", "invalidated", true, []],
    ]
  );
  // The tombstone lists every id the key was made from, so an account
  // deletion of any of them still finds and removes it.
  const lost = await prisma.supportTriageGroup.findFirstOrThrow({
    where: { state: "invalidated" },
    select: { retiredMemberIds: true, groupCandidateKey: true },
  });
  assert.deepEqual([...lost.retiredMemberIds].sort(), ["a", "b", "c"].map((id) => `${PREFIX}${id}`));
  assert.match(lost.groupCandidateKey ?? "", /^[0-9a-f]{64}$/);
});

test("the pass's membership budget leaves later groups for later", async () => {
  for (const id of ["a1", "a2"]) await report(id, { userId: "user-gf-1" });
  for (const id of ["b1", "b2"]) await report(id, { userId: "user-gf-2" });
  const run = await startSupportTriageRun("worker");
  const ids = ["a1", "a2", "b1", "b2"].map((id) => `${PREFIX}${id}`);
  const batch = await claimSupportTriageBatch(run, ids);
  const result = await writeSupportTriageResults(run, batch.token as string, batch.claimed, {
    peerIds: await readGroupPeers(ids),
    membershipBudget: 3,
  });
  assert.equal(result.groups.groupsCreated, 1);
  assert.equal(result.groups.budgetDeferred, 1);
  assert.equal(result.groups.membershipsUsed, 2);
});

test("a join that waited for another pass's join counts that member once, so the fiftieth still fits", async () => {
  const existing = Array.from({ length: 48 }, (_, i) => `m${String(i).padStart(2, "0")}`);
  for (const id of existing) await report(id, { userId: "user-gf-1" });
  await runSupportTriageWorker();
  const { id: groupId } = await onlyGroup();
  assert.equal(await prisma.supportTriageGroupMember.count({ where: { groupId } }), 48);
  await report("y", { userId: "user-gf-1" });
  await report("z", { userId: "user-gf-1" });
  const run = await startSupportTriageRun("worker");
  const batch = await claimSupportTriageBatch(run, [`${PREFIX}z`]);
  const peerIds = await readGroupPeers([`${PREFIX}z`]);

  // Another pass joins y to the group and holds its lock uncommitted.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let inserted!: () => void;
  const ready = new Promise<void>((resolve) => (inserted = resolve));
  const digest = groupSnapshotDigest("user-gf-1");
  const other = prisma.$transaction(
    async (tx) => {
      await tx.supportTriageGroupMember.create({
        data: { groupId, feedbackId: `${PREFIX}y`, primarySnapshotDigest: digest },
      });
      inserted();
      await held;
    },
    { timeout: 30_000 }
  );
  await ready;
  // This result transaction waits for the group lock, then plans z's join.
  const writing = writeSupportTriageResults(run, batch.token as string, batch.claimed, { peerIds });
  await waitUntilALockIsAwaited();
  release();
  await other;
  const result = await writing;
  assert.equal(result.groups.memberCapReached, 0);
  assert.equal(result.groups.groupsJoined, 1);
  assert.equal(result.groups.joinedMembers, 1);
  assert.equal(await prisma.supportTriageGroupMember.count({ where: { groupId } }), 50);
});
