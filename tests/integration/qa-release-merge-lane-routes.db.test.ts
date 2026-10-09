import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import {
  handleQaReleaseMergeConsume,
  handleQaReleaseMergeInstruction,
  handleQaReleaseMergeLaneState,
  handleQaReleaseMergeReport,
} from "@/lib/qaReleaseMergeLaneRoutes";

// The merge lane service's three app calls against PostgreSQL: the lane's own
// secret, the revision it carries, a strict body, then the single writer.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const LANE = "l".repeat(40);
const env = { QA_RELEASE_MERGE_LANE_SECRET: LANE, QA_RELEASE_MONITOR_SECRET: "m".repeat(40) };
const session = { user: { id: "qa-lane-route-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const HEAD = "a".repeat(40);
let revision = 0;

const cleanup = async () => {
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
  for (const table of ["QaReleaseMergeLaneLatch", "QaReleaseMergeAttempt", "QaReleaseOperatorControl"]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_before_delete"`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${table}_before_delete"`);
    }
  }
};

beforeEach(async () => {
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

const call = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://staging.tomverse.app/api/internal/agents/qa-release/merge-lane/x", {
    method: "POST",
    headers: {
      authorization: `Bearer ${LANE}`,
      "x-qa-release-control-revision": String(revision),
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("only the merge lane's own secret is let in; another service's secret is not", async () => {
  for (const authorization of ["", "Bearer short", `Bearer ${"m".repeat(40)}`]) {
    assert.deepEqual(await handleQaReleaseMergeInstruction(call({ pullRequestNumber: 1, headSha: HEAD }, { authorization }), env), {
      status: 401,
      body: { error: "unauthorized" },
    });
  }
});

test("a body that is not exactly the call's shape is refused before any write", async () => {
  for (const body of ["not json", { pullRequestNumber: 1 }, { pullRequestNumber: 1, headSha: HEAD, extra: true }, { pullRequestNumber: -1, headSha: HEAD }]) {
    assert.deepEqual((await handleQaReleaseMergeInstruction(call(body), env)).status, 400, JSON.stringify(body));
  }
  assert.equal((await handleQaReleaseMergeReport(call({ attemptId: "x", report: { kind: "merge", result: "merged" } }), env)).status, 400);
  assert.equal((await handleQaReleaseMergeReport(call({ attemptId: "x", report: { kind: "deploy", outcome: "maybe", observation: [] } }), env)).status, 400);
  // An observation outside the closed vocabulary is refused too.
  assert.equal(
    (await handleQaReleaseMergeReport(call({ attemptId: "x", report: { kind: "deploy", outcome: "failed", observation: [{ service: "web", status: "ON FIRE", commitSha: null }] } }), env)).status,
    400,
  );
  assert.equal(await prisma.qaReleaseMergeAttempt.count(), 0);
});

test("issue, consume and report run the lane end to end; a stale revision is refused where the policy refuses it", async () => {
  // A stale revision cannot open an attempt.
  assert.deepEqual(
    await handleQaReleaseMergeInstruction(call({ pullRequestNumber: 7, headSha: HEAD }, { "x-qa-release-control-revision": String(revision + 5) }), env),
    { status: 409, body: { issued: false, reason: "revision_mismatch" } },
  );
  const issued = await handleQaReleaseMergeInstruction(call({ pullRequestNumber: 7, headSha: HEAD }), env);
  assert.equal(issued.status, 200);
  const attemptId = issued.body.attemptId as string;
  assert.equal(typeof attemptId, "string");

  assert.deepEqual(await handleQaReleaseMergeConsume(call({ attemptId, pullRequestNumber: 7, headSha: HEAD, base: "main" }), env), {
    status: 409,
    body: { consumed: false, reason: "binding_mismatch" },
  });
  assert.deepEqual(await handleQaReleaseMergeConsume(call({ attemptId, pullRequestNumber: 7, headSha: HEAD, base: "develop" }), env), {
    status: 200,
    body: { consumed: true },
  });

  const merged = await handleQaReleaseMergeReport(
    call({ attemptId, report: { kind: "merge", result: "merged", mergeCommitSha: "b".repeat(40) } }),
    env,
  );
  assert.deepEqual(merged, { status: 200, body: { recorded: true, moved: true, latched: null, revisionMatched: true } });

  // A report from a stale revision is kept and latches (section 6).
  const stale = await handleQaReleaseMergeReport(
    call({ attemptId, report: { kind: "deploy", outcome: "succeeded", observation: [{ service: "web", status: "SUCCESS", commitSha: "b".repeat(40) }] } }, { "x-qa-release-control-revision": "999" }),
    env,
  );
  assert.deepEqual(stale, { status: 200, body: { recorded: true, moved: false, latched: "revision_mismatch", revisionMatched: false } });
  assert.equal((await prisma.qaReleaseMergeAttempt.findUniqueOrThrow({ where: { id: attemptId } })).state, "awaiting_deploy");

  // A report about a state the attempt has left records nothing.
  assert.deepEqual(await handleQaReleaseMergeReport(call({ attemptId, report: { kind: "merge", result: "refused" } }), env), {
    status: 409,
    body: { recorded: false, reason: "state_moved" },
  });
});

test("a call past its budget answers deadline_passed and records nothing", async () => {
  let calls = 0;
  // The request arrives at 0; every later reading is a minute on.
  const clock = () => (calls++ === 0 ? 0 : 60_000);
  assert.deepEqual(await handleQaReleaseMergeInstruction(call({ pullRequestNumber: 8, headSha: HEAD }), env, clock), {
    status: 503,
    body: { error: "deadline_passed" },
  });
  assert.equal(await prisma.qaReleaseMergeAttempt.count(), 0);
});

test("the state read tells the service whether the lane is latched and which attempt it holds", async () => {
  assert.equal((await handleQaReleaseMergeLaneState(call({}, { authorization: "Bearer nope" }), env)).status, 401);
  const empty = await handleQaReleaseMergeLaneState(call({}), env);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.latched, false);
  assert.equal(empty.body.openAttempt, null);
  assert.equal(typeof empty.body.dbNowMs, "number");

  const issued = await handleQaReleaseMergeInstruction(call({ pullRequestNumber: 12, headSha: HEAD }), env);
  const attemptId = issued.body.attemptId as string;
  const held = await handleQaReleaseMergeLaneState(call({}), env);
  const open = held.body.openAttempt as Record<string, unknown>;
  assert.equal(open.id, attemptId);
  assert.equal(open.state, "issued");
  assert.equal(open.pullRequestNumber, 12);
  assert.equal(open.mergeNotBeforeMs, open.issuedAtMs);
  await handleQaReleaseMergeConsume(call({ attemptId, pullRequestNumber: 12, headSha: HEAD, base: "develop" }), env);
  const consumed = (await handleQaReleaseMergeLaneState(call({}), env)).body.openAttempt as Record<string, unknown>;
  assert.equal(consumed.state, "consumed");
  assert.ok((consumed.mergeNotBeforeMs as number) >= (consumed.issuedAtMs as number));
});
