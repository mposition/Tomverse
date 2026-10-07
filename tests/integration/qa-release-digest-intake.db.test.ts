import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { buildQaReleaseDigest } from "@/lib/qaReleaseDigestBuildCore";
import { receiveQaReleaseDigest } from "@/lib/qaReleaseDigestIntake";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";

// The digest intake (lib/qaReleaseDigestIntake.ts) against PostgreSQL:
// authentication first, then the operator control revision and switch, then
// the closed schema, then the single writer.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const SECRET = "d".repeat(40);
const env = { QA_RELEASE_DIGEST_SECRET: SECRET, QA_RELEASE_MONITOR_SECRET: "m".repeat(40) };
const session = { user: { id: "qa-intake-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };

const control = (digestEnabled: boolean) => ({
  digestEnabled,
  mergeLaneEnabled: false,
  developLaneOn: false,
  iacCommit: null,
  digestSecretRotatedAt: null,
  monitorSecretRotatedAt: null,
  mergeLaneSecretRotatedAt: null,
  githubAppKeyRotatedAt: null,
  railwayTokenRotatedAt: null,
  githubReadTokenRotatedAt: null,
});

let revision = 0;

const digestFor = (date: string, pending = 40, runDeadline = new Date(Date.now() + 15 * 60_000).toISOString()) =>
  buildQaReleaseDigest({
    digestDate: date,
    baseSha: "a".repeat(40),
    generatedAt: `${date}T21:00:00.000Z`,
    runDeadline,
    gateReport: { classified: Array.from({ length: pending }, (_, i) => ({ id: `GATE-${String(i).padStart(2, "0")}`, status: "pending", verdict: "unmapped" })) },
    hypotheticalReports: [],
    issueReport: { classified: [] },
    checks: [],
    ci: [],
    releaseLane: [],
    notChecked: [],
  });

const call = (body: unknown, headers: Record<string, string> = {}) =>
  receiveQaReleaseDigest(
    new Request("https://staging.tomverse.app/api/internal/agents/qa-release/digest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
        "x-qa-release-control-revision": String(revision),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );

const cleanup = async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" DISABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "QaReleaseOperatorControl"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "idempotencyKey" LIKE 'qa-release:daily:20%'`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" ENABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
  }
};

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("with no control revision recorded, an authenticated call is unavailable and an outsider is unauthorized", async () => {
  assert.deepEqual(await call(digestFor("2026-10-01")), { status: 503, body: { error: "control_revision_unavailable" } });
  assert.deepEqual(await call(digestFor("2026-10-01"), { authorization: `Bearer ${"m".repeat(40)}` }), {
    status: 401,
    body: { error: "unauthorized" },
  });
});

test("a recorded but disabled digest is refused; a stale revision is a mismatch", async () => {
  revision = (await recordQaReleaseOperatorControl({ session: session as never, control: control(false) })).revision;
  assert.deepEqual(await call(digestFor("2026-10-01")), { status: 409, body: { error: "digest_disabled" } });
  revision = (await recordQaReleaseOperatorControl({ session: session as never, control: control(true) })).revision;
  assert.deepEqual(await call(digestFor("2026-10-01"), { "x-qa-release-control-revision": String(revision - 1) }), {
    status: 409,
    body: { error: "control_revision_mismatch" },
  });
});

test("a valid digest is stored once a day; the same bytes replay and a different body conflicts", async () => {
  const digest = digestFor("2026-10-02");
  const created = await call(digest);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "created");
  const replay = await call(JSON.stringify(digest, null, 2));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, created.body.id);
  assert.deepEqual(await call(digestFor("2026-10-02", 39)), { status: 409, body: { error: "digest_conflict" } });
  const row = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: String(created.body.id) } });
  assert.equal(row.idempotencyKey, "qa-release:daily:2026-10-02");
});

test("anything outside the closed schema is refused without echoing it", async () => {
  const digest = { ...digestFor("2026-10-03"), note: "an issue title that must never be stored" };
  const refused = await call(digest);
  assert.deepEqual(refused, { status: 400, body: { error: "invalid_digest" } });
  assert.deepEqual(await call("{not json"), { status: 400, body: { error: "invalid_digest" } });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: "qa-release:daily:2026-10-03" } }), 0);
});

test("a revision recorded while the body is still arriving stops the digest from being stored", async () => {
  const digest = JSON.stringify(digestFor("2026-10-04"));
  const startRevision = revision;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // The operator switches the digest off after the early check has
      // passed and before the body is complete.
      await recordQaReleaseOperatorControl({ session: session as never, control: control(false) });
      controller.enqueue(new TextEncoder().encode(digest));
      controller.close();
    },
  });
  const result = await receiveQaReleaseDigest(
    new Request("https://staging.tomverse.app/api/internal/agents/qa-release/digest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
        "x-qa-release-control-revision": String(startRevision),
      },
      body,
      duplex: "half",
    } as RequestInit),
    env,
  );
  assert.deepEqual(result, { status: 409, body: { error: "control_revision_mismatch" } });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: "qa-release:daily:2026-10-04" } }), 0);
});

test("a digest submitted after its own run deadline is not recorded", async () => {
  revision = (await recordQaReleaseOperatorControl({ session: session as never, control: control(true) })).revision;
  const late = digestFor("2026-10-05", 40, new Date(Date.now() - 1000).toISOString());
  assert.deepEqual(await call(late), { status: 409, body: { error: "run_deadline_passed" } });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: "qa-release:daily:2026-10-05" } }), 0);
});

// Policy sections 6 and 7: the intake refuses a call on another revision and a
// second, different digest for a day, and queues the needs-a-check alert --
// one row per UTC day with its system audit entry -- which the Monitor cannot
// raise for either.
test("a revision mismatch or a digest conflict queues today's needs-a-check alert once, with its audit", async () => {
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_attention" } });
  revision = (await recordQaReleaseOperatorControl({ session: session as never, control: control(true) })).revision;
  assert.deepEqual(await call(digestFor("2026-10-06"), { "x-qa-release-control-revision": String(revision - 1) }), {
    status: 409,
    body: { error: "control_revision_mismatch" },
  });
  const [alert] = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_attention" } });
  assert.ok(alert);
  assert.match(alert.referenceId, /^attention:\d{4}-\d{2}-\d{2}$/);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "qa_release.attention_alerted", targetId: alert.id },
  });
  assert.equal((audit.metadata as Record<string, unknown>).reason, "control_revision_mismatch");
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "qa-release-intake");

  // Same UTC day: the conflict is refused and finds today's row, so no second one.
  assert.equal((await call(digestFor("2026-10-06"))).status, 201);
  assert.deepEqual(await call(digestFor("2026-10-06", 39)), { status: 409, body: { error: "digest_conflict" } });
  assert.equal(await prisma.notificationDelivery.count({ where: { kind: "qa_release_attention" } }), 1);

  // A fresh day's row is queued for a conflict on its own.
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_attention" } });
  assert.deepEqual(await call(digestFor("2026-10-06", 38)), { status: 409, body: { error: "digest_conflict" } });
  const [conflict] = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_attention" } });
  const conflictAudit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "qa_release.attention_alerted", targetId: conflict.id },
  });
  assert.equal((conflictAudit.metadata as Record<string, unknown>).reason, "digest_conflict");
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_attention" } });
});

test("a run deadline further away than the service's whole hard timeout is treated as passed", async () => {
  const far = digestFor("2026-10-07", 40, new Date(Date.now() + 16 * 60_000).toISOString());
  assert.deepEqual(await call(far), { status: 409, body: { error: "run_deadline_passed" } });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: "qa-release:daily:2026-10-07" } }), 0);
  assert.equal((await call(digestFor("2026-10-07", 40, new Date(Date.now() + 14 * 60_000).toISOString()))).status, 201);
});
