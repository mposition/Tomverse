import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import pg from "pg";

import { resolvePostgresConnectionConfig } from "@/lib/postgresConnectionConfigCore.mjs";
import { prisma } from "@/lib/prisma";
import { DECISION_RECORD_LINKS_MAX, GROUP_MEMBER_CAP } from "@/lib/supportTriageCore";

// SupportTriageDecisionRecord and its links (docs/policy/support-triage.md §5, §6).
//
// What needs a database: the clock, the twelve-month CHECK, the deferred
// at-least-one-link check, the fifty cap and "no record outlives any of its
// links" are triggers and constraints of migration
// 20261005010000_support_triage_decision_record.

const DIGEST = "d".repeat(64);

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageDecisionRecord"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageGroup"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-dr-" } } });
};

const report = (id: string, message = "decision fixture") =>
  prisma.feedback.create({ data: { id: `fb-dr-${id}`, type: "bug", message } });

/** A record and its links in one transaction, as the decision route writes them. */
const decide = (id: string, feedbackIds: string[], kind = "group_confirmed") =>
  prisma.$transaction(async (tx) => {
    await tx.supportTriageDecisionRecord.create({
      data: { id, decisionKind: kind, decisionEnvelopeDigest: DIGEST, digestVersion: 1 },
    });
    for (const [i, feedbackId] of feedbackIds.entries()) {
      await tx.supportTriageDecisionRecordLink.create({
        data: { id: `${id}-l${i}`, recordId: id, feedbackId: `fb-dr-${feedbackId}` },
      });
    }
  });

beforeEach(async () => {
  await reset();
  await report("a");
  await report("b");
  await report("c");
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("the database stamps decidedAt and keeps the record exactly twelve months", async () => {
  await decide("r1", ["a"]);
  const row = await prisma.supportTriageDecisionRecord.findUniqueOrThrow({ where: { id: "r1" } });
  const expected = new Date(row.decidedAt);
  expected.setUTCMonth(expected.getUTCMonth() + 12);
  assert.equal(row.retentionUntil.getTime(), expected.getTime());
  assert.ok(Math.abs(row.decidedAt.getTime() - Date.now()) < 60_000);
  // A caller's times are overwritten, not trusted.
  await prisma.$transaction(async (tx) => {
    await tx.supportTriageDecisionRecord.create({
      data: { id: "r2", decisionKind: "sample_judged", decisionEnvelopeDigest: DIGEST, digestVersion: 1, decidedAt: new Date(0), retentionUntil: new Date(0) },
    });
    await tx.supportTriageDecisionRecordLink.create({ data: { id: "r2-l0", recordId: "r2", feedbackId: "fb-dr-b" } });
  });
  const r2 = await prisma.supportTriageDecisionRecord.findUniqueOrThrow({ where: { id: "r2" } });
  assert.ok(r2.decidedAt.getTime() > 0);
});

test("records and links are never updated", async () => {
  await decide("r1", ["a"]);
  await assert.rejects(
    prisma.supportTriageDecisionRecord.update({ where: { id: "r1" }, data: { digestVersion: 2 } }),
    /never updated/
  );
  await assert.rejects(
    prisma.supportTriageDecisionRecordLink.update({ where: { id: "r1-l0" }, data: { feedbackId: "fb-dr-b" } }),
    /never updated/
  );
});

test("a record cannot commit without a link", async () => {
  await assert.rejects(
    prisma.supportTriageDecisionRecord.create({
      data: { id: "lonely", decisionKind: "suggestion_rejected", decisionEnvelopeDigest: DIGEST, digestVersion: 1 },
    }),
    /has no link/
  );
  assert.equal(await prisma.supportTriageDecisionRecord.count(), 0);
});

test("closed kinds, a hex digest and a positive key version", async () => {
  for (const data of [
    { decisionKind: "group_merged" },
    { decisionEnvelopeDigest: "raw input digest" },
    { digestVersion: 0 },
  ]) {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.supportTriageDecisionRecord.create({
          data: { id: "bad", decisionKind: "group_confirmed", decisionEnvelopeDigest: DIGEST, digestVersion: 1, ...data },
        });
        await tx.supportTriageDecisionRecordLink.create({ data: { id: "bad-l0", recordId: "bad", feedbackId: "fb-dr-a" } });
      }),
      /check constraint|_check/,
      Object.keys(data).join(",")
    );
  }
});

test("no link to a deleted account's report, and at most fifty links", async () => {
  await report("deleted", "[deleted account]");
  await assert.rejects(decide("r1", ["a", "deleted"]), /deleted account/);
  assert.equal(await prisma.supportTriageDecisionRecord.count(), 0);

  const ids = Array.from({ length: DECISION_RECORD_LINKS_MAX + 1 }, (_, i) => `cap-${String(i).padStart(2, "0")}`);
  await prisma.feedback.createMany({ data: ids.map((id) => ({ id: `fb-dr-${id}`, type: "bug", message: "cap" })) });
  await assert.rejects(decide("r2", ids), /already has 50 links/);
  await decide("r3", ids.slice(0, DECISION_RECORD_LINKS_MAX));
  assert.equal(await prisma.supportTriageDecisionRecordLink.count({ where: { recordId: "r3" } }), DECISION_RECORD_LINKS_MAX);
});

test("a gone link takes its record whole, with every other link", async () => {
  await decide("r1", ["a", "b", "c"]);
  await decide("r2", ["c"]);
  await prisma.supportTriageDecisionRecordLink.delete({ where: { id: "r1-l1" } });
  assert.deepEqual((await prisma.supportTriageDecisionRecord.findMany({ select: { id: true } })).map((r) => r.id), ["r2"]);
  assert.equal(await prisma.supportTriageDecisionRecordLink.count({ where: { recordId: "r1" } }), 0);
  // A report's own deletion does the same.
  await prisma.feedback.delete({ where: { id: "fb-dr-c" } });
  assert.equal(await prisma.supportTriageDecisionRecord.count(), 0);
  assert.equal(await prisma.supportTriageDecisionRecordLink.count(), 0);
});

test("deleting a record deletes its links", async () => {
  await decide("r1", ["a", "b"]);
  await prisma.supportTriageDecisionRecord.delete({ where: { id: "r1" } });
  assert.equal(await prisma.supportTriageDecisionRecordLink.count(), 0);
});

test("the trigger functions have no EXCEPTION handler and pin their search path", async () => {
  const rows = await prisma.$queryRawUnsafe<{ name: string; handler: boolean; config: string[] | null }[]>(
    `SELECT proname AS name, prosrc ILIKE '%EXCEPTION WHEN%' AS handler, proconfig AS config
       FROM pg_proc WHERE proname LIKE 'support_triage_decision_record%' ORDER BY proname`
  );
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.handler, false, row.name);
    assert.deepEqual(row.config, ["search_path=pg_catalog, pg_temp"], row.name);
  }
});

// The fifty caps under each isolation level. Both guards lock the parent and
// then count in a separate statement, which only READ COMMITTED counts with a
// fresh snapshot; every other level is refused. A SERIALIZABLE writer racing a
// READ COMMITTED one would count with its stale snapshot, and SSI does not
// see the READ COMMITTED side.

const directClient = async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "DATABASE_URL must point at the test database");
  const config = resolvePostgresConnectionConfig(url, { requireTestMarker: true });
  const client = new pg.Client({ connectionString: config.connectionString, options: config.poolOptions });
  await client.connect();
  return client;
};

const fill = async (prefix: string, count: number) => {
  const ids = Array.from({ length: count }, (_, i) => `fb-dr-${prefix}-${String(i).padStart(2, "0")}`);
  await prisma.feedback.createMany({ data: ids.map((id) => ({ id, type: "bug", message: "isolation" })) });
  return ids;
};

const LINK = `INSERT INTO "SupportTriageDecisionRecordLink" ("id", "recordId", "feedbackId") VALUES ('x-' || $1, 'r-iso', $1)`;
const MEMBER = `INSERT INTO "SupportTriageGroupMember" ("groupId", "feedbackId", "primarySnapshotDigest") VALUES ('g-iso', $1, '${DIGEST}')`;

/** A record or group one short of its cap, and two more reports. */
const nearlyFull = async (kind: "link" | "member") => {
  const ids = await fill(kind, 51);
  if (kind === "link") {
    await prisma.$transaction(async (tx) => {
      await tx.supportTriageDecisionRecord.create({ data: { id: "r-iso", decisionKind: "group_confirmed", decisionEnvelopeDigest: DIGEST, digestVersion: 1 } });
      for (const [i, feedbackId] of ids.slice(0, 49).entries()) {
        await tx.supportTriageDecisionRecordLink.create({ data: { id: `r-iso-l${i}`, recordId: "r-iso", feedbackId } });
      }
    });
  } else {
    await prisma.supportTriageGroup.create({ data: { id: "g-iso", primaryKind: "same_account", primarySnapshotDigest: DIGEST, groupCandidateKey: "9".repeat(64) } });
    for (const feedbackId of ids.slice(0, GROUP_MEMBER_CAP - 1)) {
      await prisma.supportTriageGroupMember.create({ data: { groupId: "g-iso", feedbackId, primarySnapshotDigest: DIGEST } });
    }
  }
  return { sql: kind === "link" ? LINK : MEMBER, fiftieth: ids[49], fiftyFirst: ids[50] };
};

const count = (kind: "link" | "member") =>
  kind === "link"
    ? prisma.supportTriageDecisionRecordLink.count({ where: { recordId: "r-iso" } })
    : prisma.supportTriageGroupMember.count({ where: { groupId: "g-iso" } });

for (const kind of ["link", "member"] as const) {
  for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
    test(`${kind}: ${level} is refused`, async () => {
      const { sql, fiftieth } = await nearlyFull(kind);
      const client = await directClient();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        await assert.rejects(client.query(sql, [fiftieth]), /inserted only under READ COMMITTED/);
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
      assert.equal(await count(kind), 49);
    });
  }

  test(`${kind}: two READ COMMITTED inserts at forty-nine leave fifty, never fifty-one`, async () => {
    const { sql, fiftieth, fiftyFirst } = await nearlyFull(kind);
    const first = await directClient();
    const second = await directClient();
    try {
      const secondPid = (await second.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0].pid as number;
      await first.query("BEGIN");
      await first.query(sql, [fiftieth]);
      const late = second.query(sql, [fiftyFirst]).then(
        () => "inserted",
        (error: Error) => error.message
      );
      for (let i = 0; ; i += 1) {
        const [row] = await prisma.$queryRaw<{ n: number }[]>`
          SELECT pg_catalog.cardinality(pg_catalog.pg_blocking_pids(${secondPid}::int))::int AS n`;
        if (row.n > 0) break;
        assert.ok(i < 100, "the second insert never waited on the first");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await first.query("COMMIT");
      assert.match(await late, /already has 50/);
    } finally {
      await first.end();
      await second.end();
    }
    assert.equal(await count(kind), 50);
  });
}
