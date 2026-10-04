import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import pg from "pg";

import { resolvePostgresConnectionConfig } from "@/lib/postgresConnectionConfigCore.mjs";
import { prisma } from "@/lib/prisma";
import { GROUP_MEMBER_CAP, GROUP_STATES, GROUP_TRANSITIONS } from "@/lib/supportTriageCore";

// SupportTriageGroup, its members and its signals (docs/policy/support-triage.md §5, §6).
//
// What needs a database: the state machine, the composite key that ties a
// member to its group's digest, the end-of-group order and the tombstone live
// in migration 20261004020000_support_triage_group. Some fixtures move a
// timestamp into the past; the trigger forbids exactly that, so they disable
// it for one statement and re-enable it at once.

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const KEY = "c".repeat(64);

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageGroup"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-group-" } } });
};

const report = (id: string, message = "group fixture") =>
  prisma.feedback.create({ data: { id: `fb-group-${id}`, type: "bug", message } });

const group = (id = "g1", key = KEY, kind = "same_account") =>
  prisma.supportTriageGroup.create({
    data: { id, primaryKind: kind, primarySnapshotDigest: DIGEST, groupCandidateKey: key },
  });

const member = (groupId: string, feedbackId: string, digest = DIGEST) =>
  prisma.supportTriageGroupMember.create({
    data: { groupId, feedbackId: `fb-group-${feedbackId}`, primarySnapshotDigest: digest },
  });

const signal = (groupId: string, kind = "same_account", provenanceClass = "account_derived") =>
  prisma.supportTriageGroupSignal.create({
    data: { groupId, kind, provenanceClass, snapshotDigest: DIGEST, snapshotExpiresAt: new Date(Date.now() + 86_400_000) },
  });

const update = (id: string, data: Record<string, unknown>) =>
  prisma.supportTriageGroup.update({ where: { id }, data });

/** Members, then signals, then the group: the only order the database accepts. */
const end = async (id: string, state: string, extra: Record<string, unknown> = {}) => {
  const members = await prisma.supportTriageGroupMember.findMany({ where: { groupId: id }, select: { feedbackId: true } });
  await prisma.supportTriageGroupMember.deleteMany({ where: { groupId: id } });
  await prisma.supportTriageGroupSignal.deleteMany({ where: { groupId: id } });
  return update(id, {
    state,
    primarySnapshotDigest: null,
    retiredMemberIds: members.map((row) => row.feedbackId),
    ...extra,
  });
};

const withGuardDisabled = async (sql: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageGroup" DISABLE TRIGGER "SupportTriageGroup_guard"`);
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageGroup" ENABLE TRIGGER "SupportTriageGroup_guard"`);
  }
};

beforeEach(async () => {
  await reset();
  await report("a");
  await report("b");
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a group is born an undecided, unqueued candidate with a key and a digest", async () => {
  const row = await group();
  assert.equal(row.state, "candidate");
  assert.equal(row.ownerQueueState, "not_queued");
  assert.deepEqual(row.retiredMemberIds, []);
  for (const data of [
    { state: "confirmed" },
    { decision: "confirmed", decidedAt: new Date() },
    { keyRetiredAt: new Date() },
    { retiredMemberIds: ["fb-group-a"] },
    { ownerQueueState: "displayed", displayedAt: new Date() },
    { keyRecheckDeferredCount: 1 },
  ]) {
    await assert.rejects(
      prisma.supportTriageGroup.create({
        data: { id: "bad", primaryKind: "same_account", primarySnapshotDigest: DIGEST, groupCandidateKey: OTHER_DIGEST, ...data },
      }),
      /undecided, unqueued candidate|check constraint/,
      Object.keys(data).join(",")
    );
  }
  // An open group must carry its digest and its key.
  await assert.rejects(
    prisma.supportTriageGroup.create({ data: { id: "nodigest", primaryKind: "same_account", groupCandidateKey: OTHER_DIGEST } }),
    /primary_digest_open_check|check constraint/
  );
  await assert.rejects(
    prisma.supportTriageGroup.create({ data: { id: "nokey", primaryKind: "same_account", primarySnapshotDigest: DIGEST } }),
    /key_open_check|check constraint/
  );
});

test("a member carries its group's digest; any other digest has no group to point at", async () => {
  await group();
  await member("g1", "a");
  await assert.rejects(member("g1", "b", OTHER_DIGEST), /group_digest_fkey|Foreign key/i);
});

test("a report is a member of at most one group", async () => {
  await group("g1", KEY);
  await group("g2", OTHER_DIGEST);
  await member("g1", "a");
  await assert.rejects(member("g2", "a"), /Unique constraint|unique/i);
});

test("ending a group needs members gone first, then signals; the reverse order fails", async () => {
  await group();
  await member("g1", "a");
  await member("g1", "b");
  // Negative control: the group first, members still present. The composite
  // key refuses it, not the trigger.
  await assert.rejects(
    update("g1", { state: "invalidated", primarySnapshotDigest: null }),
    /group_digest_fkey|Foreign key/i
  );
  await prisma.supportTriageGroupMember.deleteMany({ where: { groupId: "g1" } });
  // Members gone, signals still present.
  await signal("g1");
  await assert.rejects(update("g1", { state: "invalidated", primarySnapshotDigest: null }), /still has signals/);
  await prisma.supportTriageGroupSignal.deleteMany({ where: { groupId: "g1" } });
  const ended = await update("g1", {
    state: "invalidated",
    primarySnapshotDigest: null,
    retiredMemberIds: ["fb-group-a", "fb-group-b"],
  });
  assert.equal(ended.primarySnapshotDigest, null);
  assert.ok(ended.keyRetiredAt);
  assert.equal(ended.groupCandidateKey, KEY, "the key stays as a tombstone");
});

test("the primary digest changes only to NULL, with the group's end; the kind never changes", async () => {
  await group();
  await assert.rejects(update("g1", { primarySnapshotDigest: OTHER_DIGEST }), /changes only to NULL/);
  await assert.rejects(update("g1", { primaryKind: "server_evidence_match" }), /immutable/);
  await assert.rejects(end("g1", "expired", { primarySnapshotDigest: DIGEST }), /drop its primary digest|check constraint/);
  await assert.rejects(end("g1", "expired", { groupCandidateKey: OTHER_DIGEST }), /keeps its key/);
});

test("only the core table's transitions are allowed", async () => {
  const allowed = new Set(GROUP_TRANSITIONS.map(([a, b]) => `${a}->${b}`));
  await group("g1");
  for (const to of GROUP_STATES) {
    if (to === "candidate" || allowed.has(`candidate->${to}`)) continue;
    await assert.rejects(update("g1", { state: to }), /cannot go from/, to);
  }
  // confirmed cannot be dismissed or expire; it can only be invalidated.
  await update("g1", { state: "confirmed", decision: "confirmed" });
  for (const to of ["dismissed", "expired", "candidate"]) {
    await assert.rejects(update("g1", { state: to, decision: to === "dismissed" ? "dismissed" : undefined }), /cannot go from|decision/, to);
  }
});

test("a decision is written only with the move it decides and survives invalidation", async () => {
  await group();
  await assert.rejects(update("g1", { decision: "confirmed" }), /only with the decided move/);
  await assert.rejects(update("g1", { state: "confirmed", decision: "dismissed" }), /only with the decided move/);
  await assert.rejects(update("g1", { state: "confirmed" }), /decision_state_check|check constraint/);
  const confirmed = await update("g1", { state: "confirmed", decision: "confirmed" });
  assert.ok(confirmed.decidedAt);
  const ended = await end("g1", "invalidated");
  assert.equal(ended.decision, "confirmed");
  assert.equal(ended.decidedAt?.getTime(), confirmed.decidedAt.getTime());
});

test("a terminal group never changes except to clear its tombstone after the cooldown", async () => {
  await group();
  await member("g1", "a");
  await end("g1", "dismissed", { decision: "dismissed" });
  for (const data of [
    { state: "candidate" },
    { decision: null },
    { groupInputDigest: OTHER_DIGEST },
    { retiredMemberIds: [] },
    { groupCandidateKey: null },
  ]) {
    await assert.rejects(update("g1", data), /is terminal|check constraint/, Object.keys(data).join(","));
  }
  // The key and the list clear together, and not inside the cooldown.
  await assert.rejects(update("g1", { groupCandidateKey: null, retiredMemberIds: [] }), /inside its cooldown/);
  await withGuardDisabled(
    `UPDATE "SupportTriageGroup" SET "keyRetiredAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '8 days' WHERE id = 'g1'`
  );
  const cleared = await update("g1", { groupCandidateKey: null, retiredMemberIds: [] });
  assert.equal(cleared.groupCandidateKey, null);
  assert.deepEqual(cleared.retiredMemberIds, []);
  // A list without its key is not a tombstone.
  await assert.rejects(update("g1", { retiredMemberIds: ["fb-group-a"] }), /is terminal|check constraint/);
});

test("the key is unique, so one member set cannot be grouped twice, and a tombstone holds it", async () => {
  await group("g1", KEY);
  await assert.rejects(group("g2", KEY), /Unique constraint|unique/i);
  await end("g1", "expired");
  await assert.rejects(group("g3", KEY), /Unique constraint|unique/i);
});

test("a group holds at most fifty members", async () => {
  await group();
  const ids = Array.from({ length: GROUP_MEMBER_CAP + 1 }, (_, i) => `cap-${String(i).padStart(2, "0")}`);
  await prisma.feedback.createMany({
    data: ids.map((id) => ({ id: `fb-group-${id}`, type: "bug", message: "cap fixture" })),
  });
  for (const id of ids.slice(0, GROUP_MEMBER_CAP)) await member("g1", id);
  await assert.rejects(member("g1", ids[GROUP_MEMBER_CAP]), /already has 50 members/);
});

test("no membership or signal for a deleted account's report or a terminal group", async () => {
  await report("deleted", "[deleted account]");
  await group("g1");
  await assert.rejects(member("g1", "deleted"), /deleted account/);
  await group("g2", OTHER_DIGEST);
  await end("g2", "expired");
  await assert.rejects(signal("g2"), /is terminal and takes no signal/);
});

test("members and signals are never updated; signals keep provenance tied to kind", async () => {
  await group();
  await member("g1", "a");
  await signal("g1");
  await assert.rejects(
    prisma.supportTriageGroupMember.update({
      where: { groupId_feedbackId: { groupId: "g1", feedbackId: "fb-group-a" } },
      data: { createdAt: new Date(0) },
    }),
    /never updated/
  );
  await assert.rejects(
    prisma.supportTriageGroupSignal.update({
      where: { groupId_kind: { groupId: "g1", kind: "same_account" } },
      data: { snapshotDigest: OTHER_DIGEST },
    }),
    /never updated/
  );
  await assert.rejects(signal("g1", "autofix_fingerprint", "account_derived"), /provenance_kind_check|check constraint/);
  await assert.rejects(signal("g1"), /Unique constraint|unique/i);
});

test("departed member ids are distinct, non-null and at most fifty", async () => {
  await group("g1");
  await assert.rejects(end("g1", "expired", { retiredMemberIds: ["x", "x"] }), /distinct, non-null/);
  await assert.rejects(
    end("g1", "expired", { retiredMemberIds: Array.from({ length: 51 }, (_, i) => `x${i}`) }),
    /retiredMemberIds_check|check constraint/
  );
});

test("display is reached once, from not_queued, while candidate, and stamped by the database", async () => {
  await group();
  const shown = await update("g1", { ownerQueueState: "displayed" });
  assert.ok(shown.displayedAt);
  await assert.rejects(update("g1", { displayedAt: new Date(0) }), /written by the database/);
  await assert.rejects(update("g1", { ownerQueueState: "not_queued" }), /only once, while candidate/);
  await group("g2", OTHER_DIGEST);
  await update("g2", { state: "confirmed", decision: "confirmed" });
  await assert.rejects(update("g2", { ownerQueueState: "displayed" }), /only once, while candidate/);
});

test("deleting a report removes its membership; deleting a group removes its members and signals", async () => {
  await group();
  await member("g1", "a");
  await member("g1", "b");
  await signal("g1");
  await prisma.feedback.delete({ where: { id: "fb-group-a" } });
  assert.equal(await prisma.supportTriageGroupMember.count({ where: { groupId: "g1" } }), 1);
  await prisma.supportTriageGroup.delete({ where: { id: "g1" } });
  assert.equal(await prisma.supportTriageGroupMember.count(), 0);
  assert.equal(await prisma.supportTriageGroupSignal.count(), 0);
});

test("the guard functions have no EXCEPTION handler and pin their search path", async () => {
  const rows = await prisma.$queryRawUnsafe<{ name: string; handler: boolean; config: string[] | null }[]>(
    `SELECT proname AS name, prosrc ILIKE '%EXCEPTION WHEN%' AS handler, proconfig AS config
       FROM pg_proc
      WHERE proname IN ('support_triage_group_guard', 'support_triage_group_member_guard', 'support_triage_group_signal_guard')
      ORDER BY proname`
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.handler, false, row.name);
    assert.deepEqual(row.config, ["search_path=pg_catalog, pg_temp"], row.name);
  }
});

const directClient = async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "DATABASE_URL must point at the test database");
  const config = resolvePostgresConnectionConfig(url, { requireTestMarker: true });
  const client = new pg.Client({ connectionString: config.connectionString, options: config.poolOptions });
  await client.connect();
  return client;
};

test("two connections adding the fiftieth and fifty-first member: one is refused", async () => {
  await group();
  const ids = Array.from({ length: GROUP_MEMBER_CAP + 1 }, (_, i) => `race-${String(i).padStart(2, "0")}`);
  await prisma.feedback.createMany({
    data: ids.map((id) => ({ id: `fb-group-${id}`, type: "bug", message: "race fixture" })),
  });
  for (const id of ids.slice(0, GROUP_MEMBER_CAP - 1)) await member("g1", id);
  const first = await directClient();
  const second = await directClient();
  try {
    const secondPid = (await second.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid as number;
    const insert = `INSERT INTO "SupportTriageGroupMember" ("groupId", "feedbackId", "primarySnapshotDigest") VALUES ('g1', $1, $2)`;
    await first.query("BEGIN");
    await first.query(insert, [`fb-group-${ids[GROUP_MEMBER_CAP - 1]}`, DIGEST]);
    const late = second.query(insert, [`fb-group-${ids[GROUP_MEMBER_CAP]}`, DIGEST]).then(
      () => "inserted",
      (error: Error) => error.message
    );
    // The second insert is waiting on the group lock the first one holds.
    for (let i = 0; ; i += 1) {
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT pg_catalog.cardinality(pg_catalog.pg_blocking_pids(${secondPid}::int))::int AS n`;
      if (row.n > 0) break;
      assert.ok(i < 100, "the second insert never waited on the first");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await first.query("COMMIT");
    assert.match(await late, /already has 50 members/);
  } finally {
    await first.end();
    await second.end();
  }
  assert.equal(await prisma.supportTriageGroupMember.count({ where: { groupId: "g1" } }), GROUP_MEMBER_CAP);
});
