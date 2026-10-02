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

const digestFor = (date: string, pending = 40) =>
  buildQaReleaseDigest({
    digestDate: date,
    baseSha: "a".repeat(40),
    generatedAt: `${date}T21:00:00.000Z`,
    runDeadline: `${date}T21:15:00.000Z`,
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
