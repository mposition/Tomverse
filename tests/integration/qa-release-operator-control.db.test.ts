import assert from "node:assert/strict";
import { after, test } from "node:test";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  QA_RELEASE_CONTROL_AUDIT_ACTION,
  QaReleaseOperatorControlRefusedError,
  readLatestQaReleaseOperatorControl,
  recordQaReleaseOperatorControl,
} from "@/lib/qaReleaseOperatorControlStore";

// QaReleaseOperatorControl against PostgreSQL through the migration history
// (20261003010000_qa_release_operator_control): consecutive revisions, a
// same-transaction audit row by a person, and nothing ever changed or removed.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = { user: { id: "qa-control-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };

const control = (overrides = {}) => ({
  digestEnabled: true,
  mergeLaneEnabled: false,
  developLaneOn: false,
  iacCommit: "a".repeat(40),
  digestSecretRotatedAt: new Date("2026-10-01T00:00:00Z"),
  monitorSecretRotatedAt: null,
  mergeLaneSecretRotatedAt: null,
  githubAppKeyRotatedAt: null,
  railwayTokenRotatedAt: null,
  githubReadTokenRotatedAt: null,
  ...overrides,
});

after(async () => {
  // The table refuses DELETE by design; the test switches its own guard off
  // to leave the disposable database as it found it.
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" DISABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "QaReleaseOperatorControl"`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" ENABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
  }
  await prisma.$disconnect();
});

const newestRevision = async () => (await readLatestQaReleaseOperatorControl())?.revision ?? 0;

test("each record is the next revision, audited by the operator, with rotation times and no values", async () => {
  const before = await newestRevision();
  const first = await recordQaReleaseOperatorControl({ session: session as never, control: control() });
  const second = await recordQaReleaseOperatorControl({
    session: session as never,
    control: control({ developLaneOn: true, iacCommit: null }),
  });
  assert.equal(first.revision, before + 1);
  assert.equal(second.revision, before + 2);
  assert.equal((await readLatestQaReleaseOperatorControl())?.revision, second.revision);

  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: second.auditLogId } });
  assert.equal(audit.action, QA_RELEASE_CONTROL_AUDIT_ACTION);
  assert.equal(audit.targetId, String(second.revision));
  assert.equal(audit.actorUserId, "qa-control-operator");
  const metadata = audit.metadata as { rotated: Record<string, string | null> };
  assert.equal(metadata.rotated.digestSecretRotatedAt, "2026-10-01T00:00:00.000Z");
});

test("concurrent saves are serialized into consecutive revisions", async () => {
  const before = await newestRevision();
  const results = await Promise.all(
    Array.from({ length: 3 }, () => recordQaReleaseOperatorControl({ session: session as never, control: control() })),
  );
  assert.deepEqual(results.map((row) => row.revision).sort((a, b) => a - b), [before + 1, before + 2, before + 3]);
});

test("an invalid IaC commit is refused before any write", async () => {
  const before = await newestRevision();
  await assert.rejects(
    recordQaReleaseOperatorControl({ session: session as never, control: control({ iacCommit: "main" }) }),
    QaReleaseOperatorControlRefusedError,
  );
  assert.equal(await newestRevision(), before);
});

const directInsert = (revision: number, auditLogId: string) =>
  prisma.$executeRawUnsafe(
    `INSERT INTO "QaReleaseOperatorControl" ("revision", "digestEnabled", "mergeLaneEnabled", "developLaneOn", "auditLogId")
     VALUES ($1, true, false, false, $2)`,
    revision,
    auditLogId,
  );

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** An audit row through the real writers, so the chain stays valid. */
const audit = (tx: Tx | undefined, data: { person: boolean; targetId: string; action?: string }) =>
  data.person
    ? writeAdminAuditLog({
        tx,
        session: session as never,
        action: data.action ?? QA_RELEASE_CONTROL_AUDIT_ACTION,
        targetType: "QaReleaseOperatorControl",
        targetId: data.targetId,
        summary: "test",
      })
    : writeSystemAuditLog({
        tx: tx as Tx,
        systemActor: "qa-release-intake",
        action: data.action ?? QA_RELEASE_CONTROL_AUDIT_ACTION,
        targetType: "QaReleaseOperatorControl",
        targetId: data.targetId,
        summary: "test",
      });

const insertWithAudit = (revision: number, data: { person: boolean; targetId: string; action?: string }) =>
  prisma.$transaction(async (tx) => {
    const auditLogId = await audit(tx, data);
    await tx.$executeRawUnsafe(
      `INSERT INTO "QaReleaseOperatorControl" ("revision", "digestEnabled", "mergeLaneEnabled", "developLaneOn", "auditLogId")
       VALUES ($1, true, false, false, $2)`,
      revision,
      auditLogId,
    );
  });

test("the database refuses a row without a same-transaction audit row by a person", async () => {
  const next = (await newestRevision()) + 1;
  // An audit row committed earlier, in another transaction.
  const earlier = await audit(undefined, { person: true, targetId: String(next) });
  await assert.rejects(directInsert(next, earlier), /audited by a person in the same transaction/);
  await assert.rejects(directInsert(next, "no-such-row"), /audited by a person in the same transaction/);
  await assert.rejects(insertWithAudit(next, { person: false, targetId: String(next) }), /by a person/);
  await assert.rejects(insertWithAudit(next, { person: true, targetId: String(next + 1) }), /by a person/);
  await assert.rejects(insertWithAudit(next, { person: true, targetId: String(next), action: "other" }), /by a person/);
  assert.equal(await newestRevision(), next - 1);
});

test("revisions are consecutive: a gap or a repeat is refused", async () => {
  const next = (await newestRevision()) + 1;
  for (const revision of [next + 1, next - 1]) {
    await assert.rejects(
      insertWithAudit(revision, { person: true, targetId: String(revision) }),
      revision === next - 1 && next === 1 ? /revision_check|consecutive/ : /consecutive/,
      String(revision),
    );
  }
});

test("nothing is ever changed or removed", async () => {
  const row = await recordQaReleaseOperatorControl({ session: session as never, control: control() });
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "QaReleaseOperatorControl" SET "developLaneOn" = true WHERE "revision" = $1`, row.revision),
    /append-only/,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`DELETE FROM "QaReleaseOperatorControl" WHERE "revision" = $1`, row.revision),
    /append-only/,
  );
  // Refused either way: the merge-lane attempt table's foreign key refuses it
  // before the append-only trigger runs.
  await assert.rejects(
    prisma.$executeRawUnsafe(`TRUNCATE "QaReleaseOperatorControl"`),
    /append-only|referenced in a foreign key constraint/,
  );
});

test("the clock column comes from the database and no rotation time may follow it", async () => {
  const row = await recordQaReleaseOperatorControl({ session: session as never, control: control() });
  assert.ok(Math.abs(row.createdAt.getTime() - Date.now()) < 60_000);
  await assert.rejects(
    recordQaReleaseOperatorControl({
      session: session as never,
      control: control({ railwayTokenRotatedAt: new Date(Date.now() + 86_400_000) }),
    }),
    /rotation_check/,
  );
});
