import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { DECISION_RECORD_LINKS_MAX } from "@/lib/supportTriageCore";

// SupportTriageDecisionRecord and its links (docs/policy/support-triage.md §5, §6).
//
// What needs a database: the clock, the twelve-month CHECK, the deferred
// at-least-one-link check, the fifty cap and "no record outlives any of its
// links" are triggers and constraints of migration
// 20261005010000_support_triage_decision_record.

const DIGEST = "d".repeat(64);

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageDecisionRecord"`);
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
