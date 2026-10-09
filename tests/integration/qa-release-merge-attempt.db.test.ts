import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import {
  QA_RELEASE_MERGE_ATTEMPT_OUTCOMES,
  QA_RELEASE_MERGE_ATTEMPT_STATES,
  QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS,
} from "@/lib/qaReleaseMergeAttemptCore";

// QaReleaseMergeAttempt against PostgreSQL through the migration history
// (20261004010000_qa_release_merge_attempt): one open attempt per lane, the
// lifecycle of lib/qaReleaseMergeAttemptCore.ts and nothing else, a frozen
// binding with a two-minute expiry on the database clock, a merge commit set
// once, every write audited by the right actor in the same transaction, and
// no removal.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = { user: { id: "qa-lane-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
let revision = 0;
let sequence = 0;

const cleanup = async () => {
  for (const table of ["QaReleaseMergeLaneLatch", "QaReleaseMergeAttempt", "QaReleaseOperatorControl"]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_before_delete"`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${table}_before_delete"`);
    }
  }
};

before(async () => {
  await cleanup();
  revision = (
    await recordQaReleaseOperatorControl({
      session: session as never,
      control: {
        digestEnabled: false,
        mergeLaneEnabled: true,
        developLaneOn: true,
        iacCommit: null,
        digestSecretRotatedAt: null,
        monitorSecretRotatedAt: null,
        mergeLaneSecretRotatedAt: null,
        githubAppKeyRotatedAt: null,
        railwayTokenRotatedAt: null,
        githubReadTokenRotatedAt: null,
      },
    })
  ).revision;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

type Actor = "lane" | "person" | "none";

/** One transaction: an audit row by `actor` for `id`, then `write` with that audit id. */
async function audited(id: string, actor: Actor, write: (tx: Prisma.TransactionClient, auditId: string) => Promise<unknown>, action = "qa_release.merge_attempt_recorded") {
  return prisma.$transaction(async (tx) => {
    let auditId = "no-such-audit-row";
    if (actor === "lane") {
      auditId = await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-merge-lane",
        action,
        targetType: "QaReleaseMergeAttempt",
        targetId: id,
        summary: "test",
      });
    } else if (actor === "person") {
      auditId = await writeAdminAuditLog({
        tx,
        session: session as never,
        action,
        targetType: "QaReleaseMergeAttempt",
        targetId: id,
        summary: "test",
      });
    }
    return write(tx, auditId);
  });
}

const issue = (id: string, actor: Actor = "lane") =>
  audited(id, actor, (tx: Prisma.TransactionClient, auditId) =>
    tx.$executeRaw`INSERT INTO "QaReleaseMergeAttempt"
      ("id", "pullRequestNumber", "headSha", "base", "controlRevision", "state", "lastAuditLogId")
      VALUES (${id}, 12, ${HEAD}, 'develop', ${revision}, 'issued', ${auditId})`,
  );

const move = (id: string, actor: Actor, state: string, outcome: string | null, mergeCommitSha: string | null = null) =>
  audited(id, actor, (tx: Prisma.TransactionClient, auditId) =>
    tx.$executeRaw`UPDATE "QaReleaseMergeAttempt"
       SET "state" = ${state}, "outcome" = ${outcome},
           "mergeCommitSha" = coalesce(${mergeCommitSha}, "mergeCommitSha"), "lastAuditLogId" = ${auditId}
     WHERE "id" = ${id}`,
  );

const row = async (id: string) =>
  (
    await prisma.$queryRaw<
      { state: string; outcome: string | null; mergeCommitSha: string | null; consumedAt: Date | null; closedAt: Date | null; issuedAt: Date; expiresAt: Date }[]
    >`SELECT "state", "outcome", "mergeCommitSha", "consumedAt", "closedAt", "issuedAt", "expiresAt" FROM "QaReleaseMergeAttempt" WHERE "id" = ${id}`
  )[0];

const nextId = () => `attempt-${process.pid}-${(sequence += 1)}`;

const refused = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, pattern);

test("an attempt is issued by the merge lane, audited in the same transaction, with a two-minute expiry from the database clock", async () => {
  const id = nextId();
  await issue(id);
  const r = await row(id);
  assert.equal(r.state, "issued");
  assert.equal(r.expiresAt.getTime() - r.issuedAt.getTime(), 120_000);
  assert.ok(Math.abs(r.issuedAt.getTime() - Date.now()) < 60_000);
  await move(id, "lane", "closed", "not_merged");
});

test("an insert with no audit row, or one written by a person, is refused", async () => {
  await refused(issue(nextId(), "none"), /audited by the merge lane/);
  await refused(issue(nextId(), "person"), /audited by the merge lane/);
});

test("the lane holds one open attempt; a second open one is refused until the first closes", async () => {
  const first = nextId();
  await issue(first);
  await refused(issue(nextId()), /QaReleaseMergeAttempt_one_open_per_base_key/);
  await move(first, "lane", "consumed", null);
  await refused(issue(nextId()), /QaReleaseMergeAttempt_one_open_per_base_key/);
  await move(first, "lane", "awaiting_deploy", null, MERGE);
  await refused(issue(nextId()), /QaReleaseMergeAttempt_one_open_per_base_key/);
  await move(first, "lane", "closed", "deployed");
  const r = await row(first);
  assert.equal(r.state, "closed");
  assert.equal(r.outcome, "deployed");
  assert.equal(r.mergeCommitSha, MERGE);
  assert.ok(r.consumedAt && r.closedAt);
  const second = nextId();
  await issue(second);
  await move(second, "lane", "closed", "not_merged");
});

test("only the core's transitions are allowed, each with only its outcomes", async () => {
  const allowed = new Set(
    QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS.flatMap((t) =>
      t.to === "closed" ? (t.outcomes ?? []).map((o) => `${t.from}>${t.to}:${o}`) : [`${t.from}>${t.to}:`],
    ),
  );
  const setUp = async (state: string) => {
    const id = nextId();
    await issue(id);
    if (state === "consumed" || state === "awaiting_deploy") await move(id, "lane", "consumed", null);
    if (state === "awaiting_deploy") await move(id, "lane", "awaiting_deploy", null, MERGE);
    if (state === "closed") await move(id, "lane", "closed", "not_merged");
    return id;
  };
  const closeOpen = async (id: string) => {
    const state = (await row(id)).state;
    if (state === "issued" || state === "consumed") await move(id, "lane", "closed", "not_merged");
    if (state === "awaiting_deploy") await move(id, "lane", "closed", "deployed");
  };
  for (const from of QA_RELEASE_MERGE_ATTEMPT_STATES) {
    for (const to of QA_RELEASE_MERGE_ATTEMPT_STATES) {
      for (const outcome of to === "closed" ? QA_RELEASE_MERGE_ATTEMPT_OUTCOMES : [null]) {
        const key = `${from}>${to}:${outcome ?? ""}`;
        const id = await setUp(from);
        const person = outcome !== null && outcome.startsWith("person_");
        const attempt = move(id, person ? "person" : "lane", to, outcome, to === "awaiting_deploy" ? MERGE : null);
        if (allowed.has(key)) {
          await attempt;
          assert.equal((await row(id)).state, to, key);
        } else {
          await refused(attempt, /cannot move|merge commit|check constraint|violates/i);
        }
        await closeOpen(id);
      }
    }
  }
});

test("outcomes a person records come from a person, and the lane's from the lane", async () => {
  const id = nextId();
  await issue(id);
  await refused(move(id, "lane", "closed", "person_not_merged"), /right actor/);
  await refused(move(id, "person", "closed", "not_merged"), /right actor/);
  await move(id, "person", "closed", "person_not_merged");

  // A person may also place an unreported merge (no outcome) at awaiting deploy.
  const placed = nextId();
  await issue(placed);
  await move(placed, "person", "awaiting_deploy", null, MERGE);
  await refused(move(placed, "lane", "closed", "person_deployed"), /right actor/);
  await move(placed, "person", "closed", "person_restored");
});

test("the binding never changes, the merge commit is set once, and a change without a new audit row is refused", async () => {
  const id = nextId();
  await issue(id);
  for (const column of [`"pullRequestNumber" = 13`, `"headSha" = '${"c".repeat(40)}'`, `"expiresAt" = now() + interval '1 hour'`]) {
    await refused(
      audited(id, "lane", (tx: Prisma.TransactionClient, auditId) =>
        tx.$executeRawUnsafe(`UPDATE "QaReleaseMergeAttempt" SET ${column}, "lastAuditLogId" = '${auditId}' WHERE "id" = '${id}'`),
      ),
      /binding never changes/,
    );
  }
  await refused(move(id, "lane", "awaiting_deploy", null, null), /awaiting_has_merge_commit/);
  await move(id, "lane", "awaiting_deploy", null, MERGE);
  await refused(
    audited(id, "lane", (tx: Prisma.TransactionClient, auditId) =>
      tx.$executeRaw`UPDATE "QaReleaseMergeAttempt" SET "mergeCommitSha" = ${"d".repeat(40)}, "state" = 'closed', "outcome" = 'deployed', "lastAuditLogId" = ${auditId} WHERE "id" = ${id}`,
    ),
    /set once/,
  );
  await refused(
    prisma.$executeRaw`UPDATE "QaReleaseMergeAttempt" SET "state" = 'closed', "outcome" = 'deployed' WHERE "id" = ${id}`,
    /audited in the same transaction/,
  );
  await move(id, "lane", "closed", "deployed");
});

test("a consume after the expiry is refused by the database clock", async () => {
  const id = nextId();
  await issue(id);
  // Age the row past its expiry with the binding guard off, as only a test may.
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseMergeAttempt" DISABLE TRIGGER "QaReleaseMergeAttempt_before_update"`);
  try {
    await prisma.$executeRaw`UPDATE "QaReleaseMergeAttempt" SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${id}`;
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseMergeAttempt" ENABLE TRIGGER "QaReleaseMergeAttempt_before_update"`);
  }
  await refused(move(id, "lane", "consumed", null), /expired/);
  await move(id, "lane", "closed", "not_merged");
});

test("attempts are never removed", async () => {
  await refused(prisma.$executeRaw`DELETE FROM "QaReleaseMergeAttempt"`, /never removed/);
  // A plain TRUNCATE meets the latch table's foreign key first; with the
  // latch table named too, the attempt table's own trigger must refuse it.
  await refused(prisma.$executeRawUnsafe(`TRUNCATE "QaReleaseMergeAttempt"`), /never removed|referenced in a foreign key constraint/);
  await refused(prisma.$executeRawUnsafe(`TRUNCATE "QaReleaseMergeAttempt", "QaReleaseMergeLaneLatch"`), /never removed|append-only/);
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseMergeLaneLatch" DISABLE TRIGGER "QaReleaseMergeLaneLatch_before_truncate"`);
  try {
    await refused(prisma.$executeRawUnsafe(`TRUNCATE "QaReleaseMergeAttempt", "QaReleaseMergeLaneLatch"`), /never removed/);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseMergeLaneLatch" ENABLE TRIGGER "QaReleaseMergeLaneLatch_before_truncate"`);
  }
});

test("the migration's lifecycle lists are the core's", () => {
  const sql = readFileSync(
    new URL("../../prisma/migrations/20261004010000_qa_release_merge_attempt/migration.sql", import.meta.url),
    "utf8",
  );
  const states = /"state" IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
  assert.deepEqual([...states.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_ATTEMPT_STATES]);
  const outcomes = /"outcome" IS NULL OR "outcome" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
  assert.deepEqual([...outcomes.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...QA_RELEASE_MERGE_ATTEMPT_OUTCOMES]);
});

test("the audit row must be this transaction's, for this attempt, by the merge lane's own actor", async () => {
  const id = nextId();
  const insert = (tx: Prisma.TransactionClient, auditId: string) =>
    tx.$executeRaw`INSERT INTO "QaReleaseMergeAttempt"
      ("id", "pullRequestNumber", "headSha", "base", "controlRevision", "state", "lastAuditLogId")
      VALUES (${id}, 12, ${HEAD}, 'develop', ${revision}, 'issued', ${auditId})`;
  const audit = (tx: Prisma.TransactionClient, overrides: { systemActor?: "qa-release-merge-lane" | "qa-release-intake"; action?: string; targetId?: string }) =>
    writeSystemAuditLog({
      tx,
      systemActor: overrides.systemActor ?? "qa-release-merge-lane",
      action: overrides.action ?? "qa_release.merge_attempt_issued",
      targetType: "QaReleaseMergeAttempt",
      targetId: overrides.targetId ?? id,
      summary: "test",
    });

  const committed = await prisma.$transaction((tx) => audit(tx, {}));
  await refused(prisma.$transaction((tx) => insert(tx, committed)), /audited by the merge lane/);
  await refused(prisma.$transaction(async (tx) => insert(tx, await audit(tx, { targetId: `${id}-other` }))), /audited by the merge lane/);
  await refused(prisma.$transaction(async (tx) => insert(tx, await audit(tx, { systemActor: "qa-release-intake" }))), /audited by the merge lane/);
  await refused(prisma.$transaction(async (tx) => insert(tx, await audit(tx, { action: "qa_release.digest_stale_alerted" }))), /audited by the merge lane/);
  await prisma.$transaction(async (tx) => insert(tx, await audit(tx, {})));
  await move(id, "lane", "closed", "not_merged");
});
