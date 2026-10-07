import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import pg from "pg";

import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { resolvePostgresConnectionConfig } from "@/lib/postgresConnectionConfigCore.mjs";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { deleteSupportTriageDataForAccount } from "@/lib/supportTriageAccountDeletion";

// Support-triage data in a real account deletion (docs/policy/support-triage.md §5).
//
// What needs a database: account deletion keeps the reports and anonymises
// them, so the only thing that removes the triage rows derived from them is
// the delete inside that transaction. This drives the real deletion path,
// not a Feedback delete.

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageGroup"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageDecisionRecord"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-del-" } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@support-triage-deletion.test" } } });
  await resetTestFixture(prisma, `TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

const DIGEST = "a".repeat(64);

const seed = async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@support-triage-deletion.test`, accountStatus: "active", plan: "Free" },
  });
  const other = await prisma.user.create({
    data: { email: `${randomUUID()}@support-triage-deletion.test`, accountStatus: "active", plan: "Free" },
  });
  await prisma.feedback.create({ data: { id: "fb-del-mine-1", type: "bug", message: "mine one", userId: user.id } });
  await prisma.feedback.create({ data: { id: "fb-del-mine-2", type: "billing", message: "mine two", userId: user.id } });
  await prisma.feedback.create({ data: { id: "fb-del-other", type: "bug", message: "not mine", userId: other.id } });
  for (const [id, feedbackId] of [
    ["s-mine-1", "fb-del-mine-1"],
    ["s-mine-2", "fb-del-mine-2"],
    ["s-other", "fb-del-other"],
  ]) {
    await prisma.supportTriageSuggestion.create({ data: { id, feedbackId, inputDigest: DIGEST } });
  }
  // One of the account's suggestions carries a proposal, as a real one would.
  await prisma.supportTriageSuggestion.update({ where: { id: "s-mine-1" }, data: { state: "claimed", claimToken: "t" } });
  await prisma.supportTriageSuggestion.update({
    where: { id: "s-mine-1" },
    data: { state: "ready", lane: "trust_safety_human", keywordFlags: ["account_privacy"] },
  });
  return { user, other };
};

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("deleting an account deletes the triage rows derived from its reports, and only those", async () => {
  const { user } = await seed();
  const result = await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(result.deleted, true);

  assert.deepEqual(
    (await prisma.supportTriageSuggestion.findMany({ select: { id: true } })).map((row) => row.id),
    ["s-other"]
  );
  // The reports themselves stay, anonymised.
  const report = await prisma.feedback.findUniqueOrThrow({ where: { id: "fb-del-mine-1" } });
  assert.equal(report.userId, null);
  assert.equal(report.message, "[deleted account]");

  const audits = await prisma.adminAuditLog.findMany({ where: { targetType: "SupportTriageAccountData" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "support_triage.account_data_deleted");
  assert.equal(audits[0].actorUserId, null);
  assert.deepEqual(audits[0].metadata, { suggestions: 2, groups: 0, decisionRecords: 0, systemActor: "support-triage-account-deletion" });
  assert.equal(audits[0].targetId, null);
});

test("after the deletion nothing is derived again from those reports", async () => {
  const { user } = await seed();
  await deleteTomverseAccount(user.id, { cancelSubscription: false });
  await assert.rejects(
    prisma.supportTriageSuggestion.create({ data: { id: "again", feedbackId: "fb-del-mine-1", inputDigest: "b".repeat(64) } }),
    /deleted account/
  );
});

test("an account with nothing derived writes no triage audit entry", async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@support-triage-deletion.test`, accountStatus: "active", plan: "Free" },
  });
  await prisma.feedback.create({ data: { id: "fb-del-plain", type: "bug", message: "plain", userId: user.id } });
  await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: "SupportTriageAccountData" } }), 0);
});

// Two connections. The set deleted must be the set anonymised: a suggestion
// that reaches a report while the deletion runs is either deleted with it or
// refused, never left behind on an anonymised report.

const directClient = async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "DATABASE_URL must point at the test database");
  const config = resolvePostgresConnectionConfig(url, { requireTestMarker: true });
  const client = new pg.Client({ connectionString: config.connectionString, options: config.poolOptions });
  await client.connect();
  return client;
};

// Waits on the named backend only, so an unrelated waiter elsewhere in the
// cluster cannot release the holder before the interleaving under test exists.
const until = async (probe: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
};

/** Some session is blocked by this backend. */
const untilBlockedBy = (pid: number) =>
  until(async () => {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity a WHERE ${pid}::int = ANY(pg_catalog.pg_blocking_pids(a.pid))`;
    return row.n > 0;
  }, `no session was ever blocked by backend ${pid}`);

/** This backend is blocked by some session. */
const untilBlocked = (pid: number) =>
  until(async () => {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT pg_catalog.cardinality(pg_catalog.pg_blocking_pids(${pid}::int))::int AS n`;
    return row.n > 0;
  }, `backend ${pid} was never blocked`);

const backendPid = async (client: pg.Client) =>
  (await client.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid as number;

test("a suggestion inserted before the anonymisation commits is deleted with the account", async () => {
  const { user } = await seed();
  const other = await directClient();
  try {
    const otherPid = await backendPid(other);
    await other.query("BEGIN");
    // Takes FOR SHARE on the report in the guard trigger and holds it.
    await other.query(
      `INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest") VALUES ('s-race-early', 'fb-del-mine-2', $1)`,
      ["c".repeat(64)]
    );
    const deletion = deleteTomverseAccount(user.id, { cancelSubscription: false });
    // The deletion is blocked by this insert's FOR SHARE, not merely running.
    await untilBlockedBy(otherPid);
    await other.query("COMMIT");
    assert.equal((await deletion).deleted, true);
  } finally {
    await other.end();
  }
  assert.deepEqual(
    (await prisma.supportTriageSuggestion.findMany({ select: { id: true } })).map((row) => row.id),
    ["s-other"]
  );
});

test("a suggestion inserted after the anonymisation waits for it and is refused", async () => {
  const { user } = await seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let anonymised!: () => void;
  const reachedGate = new Promise<void>((resolve) => (anonymised = resolve));
  // The account-deletion order on its own, held open after the delete.
  const deletion = prisma.$transaction(
    async (tx) => {
      const reports = await tx.feedback.updateManyAndReturn({
        where: { userId: user.id },
        data: { userId: null, message: "[deleted account]" },
        select: { id: true },
      });
      const counts = await deleteSupportTriageDataForAccount(tx, reports.map((report) => report.id));
      anonymised();
      await gate;
      return counts;
    },
    { timeout: 15_000 }
  );
  await reachedGate;
  const other = await directClient();
  try {
    const otherPid = await backendPid(other);
    const late = other.query(
      `INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest") VALUES ('s-race-late', 'fb-del-mine-1', $1)`,
      ["d".repeat(64)]
    );
    const outcome = late.then(
      () => "inserted",
      (error: Error) => error.message
    );
    // The insert is waiting on the anonymised report, not already decided.
    await untilBlocked(otherPid);
    release();
    assert.deepEqual(await deletion, { suggestions: 2, groups: 0, decisionRecords: 0 });
    assert.match(await outcome, /deleted account/);
  } finally {
    await other.end();
  }
  assert.equal(await prisma.supportTriageSuggestion.count({ where: { feedbackId: { startsWith: "fb-del-mine" } } }), 0);
});

// Groups (docs/policy/support-triage.md §5): every group the account's reports
// are in, or were in before it ended, goes whatever its state, members and
// signals with it, other accounts' members included.

const GROUP_DIGEST = "e".repeat(64);

const groupWith = async (id: string, key: string, feedbackIds: string[]) => {
  await prisma.supportTriageGroup.create({
    data: { id, primaryKind: "server_evidence_match", primarySnapshotDigest: GROUP_DIGEST, groupCandidateKey: key },
  });
  for (const feedbackId of feedbackIds) {
    await prisma.supportTriageGroupMember.create({ data: { groupId: id, feedbackId, primarySnapshotDigest: GROUP_DIGEST } });
  }
  await prisma.supportTriageGroupSignal.create({
    data: {
      groupId: id,
      kind: "server_evidence_match",
      provenanceClass: "server_evidence",
      snapshotDigest: GROUP_DIGEST,
      snapshotExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
};

test("deleting an account deletes every group its reports are or were in, and only those", async () => {
  const { user } = await seed();
  await prisma.feedback.create({ data: { id: "fb-del-other-2", type: "bug", message: "not mine", userId: null } });
  await prisma.feedback.create({ data: { id: "fb-del-other-3", type: "bug", message: "not mine", userId: null } });
  // Open, with one of mine and one of someone else's.
  await groupWith("g-open", "1".repeat(64), ["fb-del-mine-1", "fb-del-other"]);
  // Ended earlier: mine survives only in the departed list.
  await groupWith("g-ended", "2".repeat(64), ["fb-del-mine-2", "fb-del-other-2"]);
  await prisma.supportTriageGroupMember.deleteMany({ where: { groupId: "g-ended" } });
  await prisma.supportTriageGroupSignal.deleteMany({ where: { groupId: "g-ended" } });
  await prisma.supportTriageGroup.update({
    where: { id: "g-ended" },
    data: { state: "expired", primarySnapshotDigest: null, retiredMemberIds: ["fb-del-mine-2", "fb-del-other-2"] },
  });
  // Nothing of mine.
  await prisma.supportTriageGroup.create({
    data: { id: "g-unrelated", primaryKind: "same_account", primarySnapshotDigest: GROUP_DIGEST, groupCandidateKey: "3".repeat(64) },
  });
  await prisma.supportTriageGroupMember.create({
    data: { groupId: "g-unrelated", feedbackId: "fb-del-other-3", primarySnapshotDigest: GROUP_DIGEST },
  });

  await deleteTomverseAccount(user.id, { cancelSubscription: false });

  assert.deepEqual((await prisma.supportTriageGroup.findMany({ select: { id: true } })).map((row) => row.id), ["g-unrelated"]);
  assert.deepEqual(
    (await prisma.supportTriageGroupMember.findMany({ select: { feedbackId: true } })).map((row) => row.feedbackId),
    ["fb-del-other-3"]
  );
  assert.equal(await prisma.supportTriageGroupSignal.count(), 0);
  const [audit] = await prisma.adminAuditLog.findMany({ where: { targetType: "SupportTriageAccountData" } });
  assert.deepEqual(audit.metadata, { suggestions: 2, groups: 2, decisionRecords: 0, systemActor: "support-triage-account-deletion" });
  await prisma.feedback.deleteMany({ where: { id: { in: ["fb-del-other-2", "fb-del-other-3"] } } });
});

test("after the deletion no membership is created for those reports", async () => {
  const { user } = await seed();
  await deleteTomverseAccount(user.id, { cancelSubscription: false });
  await prisma.supportTriageGroup.create({
    data: { id: "g-late", primaryKind: "same_account", primarySnapshotDigest: GROUP_DIGEST, groupCandidateKey: "4".repeat(64) },
  });
  await assert.rejects(
    prisma.supportTriageGroupMember.create({
      data: { groupId: "g-late", feedbackId: "fb-del-mine-1", primarySnapshotDigest: GROUP_DIGEST },
    }),
    /deleted account/
  );
});

// Decision records (docs/policy/support-triage.md §5): a record bound to any
// of the account's reports goes whole, other accounts' links included.

const record = (id: string, feedbackIds: string[]) =>
  prisma.$transaction(async (tx) => {
    await tx.supportTriageDecisionRecord.create({
      data: { id, decisionKind: "group_confirmed", decisionEnvelopeDigest: "f".repeat(64), digestVersion: 1 },
    });
    for (const [i, feedbackId] of feedbackIds.entries()) {
      await tx.supportTriageDecisionRecordLink.create({ data: { id: `${id}-l${i}`, recordId: id, feedbackId } });
    }
  });

test("deleting an account deletes every decision record bound to its reports, whole", async () => {
  const { user } = await seed();
  await record("dr-shared", ["fb-del-mine-1", "fb-del-other"]);
  await record("dr-other", ["fb-del-other"]);
  await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.deepEqual((await prisma.supportTriageDecisionRecord.findMany({ select: { id: true } })).map((r) => r.id), ["dr-other"]);
  assert.deepEqual(
    (await prisma.supportTriageDecisionRecordLink.findMany({ select: { feedbackId: true } })).map((l) => l.feedbackId),
    ["fb-del-other"]
  );
  const [audit] = await prisma.adminAuditLog.findMany({ where: { targetType: "SupportTriageAccountData" } });
  assert.deepEqual(audit.metadata, { suggestions: 2, groups: 0, decisionRecords: 1, systemActor: "support-triage-account-deletion" });
});
