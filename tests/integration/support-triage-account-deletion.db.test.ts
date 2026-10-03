import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import pg from "pg";

import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { resolvePostgresConnectionConfig } from "@/lib/postgresConnectionConfigCore.mjs";
import { prisma } from "@/lib/prisma";
import { deleteSupportTriageDataForAccount } from "@/lib/supportTriageAccountDeletion";

// Support-triage data in a real account deletion (docs/policy/support-triage.md §5).
//
// What needs a database: account deletion keeps the reports and anonymises
// them, so the only thing that removes the triage rows derived from them is
// the delete inside that transaction. This drives the real deletion path,
// not a Feedback delete.

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-del-" } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@support-triage-deletion.test" } } });
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
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

  const audits = await prisma.adminAuditLog.findMany({ where: { targetType: "SupportTriageSuggestion" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "support_triage.account_data_deleted");
  assert.equal(audits[0].actorUserId, null);
  assert.deepEqual(audits[0].metadata, { suggestions: 2, systemActor: "support-triage-account-deletion" });
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
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: "SupportTriageSuggestion" } }), 0);
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

const untilSomeoneWaitsOnALock = async () => {
  for (let i = 0; i < 100; i += 1) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
    if (row.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("no session ever waited on a lock");
};

test("a suggestion inserted before the anonymisation commits is deleted with the account", async () => {
  const { user } = await seed();
  const other = await directClient();
  try {
    await other.query("BEGIN");
    // Takes FOR SHARE on the report in the guard trigger and holds it.
    await other.query(
      `INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest") VALUES ('s-race-early', 'fb-del-mine-2', $1)`,
      ["c".repeat(64)]
    );
    const deletion = deleteTomverseAccount(user.id, { cancelSubscription: false });
    await untilSomeoneWaitsOnALock();
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
    const late = other.query(
      `INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest") VALUES ('s-race-late', 'fb-del-mine-1', $1)`,
      ["d".repeat(64)]
    );
    const outcome = late.then(
      () => "inserted",
      (error: Error) => error.message
    );
    await untilSomeoneWaitsOnALock();
    release();
    assert.deepEqual(await deletion, { suggestions: 2 });
    assert.match(await outcome, /deleted account/);
  } finally {
    await other.end();
  }
  assert.equal(await prisma.supportTriageSuggestion.count({ where: { feedbackId: { startsWith: "fb-del-mine" } } }), 0);
});
