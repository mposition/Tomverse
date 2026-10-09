import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { handleSupportTriageRun } from "@/lib/supportTriageRoutes";
import { startSupportTriageRun } from "@/lib/supportTriageRunStore";
import {
  claimSupportTriageBatch,
  runSupportTriageWorker,
  writeSupportTriageResults,
} from "@/lib/supportTriageWorker";

// One support-triage worker pass, suggestions only (design section 5.2, 5.3).
//
// What needs a database: the claim and result transactions lock the reports
// and the guard trigger owns the state machine, the lease and the attempts.

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-w-" } } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_delete"`);
  }
  await resetTestFixture(prisma, `TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

const report = (id: string, data: Record<string, unknown> = {}) =>
  prisma.feedback.create({ data: { id: `fb-w-${id}`, type: "bug", message: "The answer stops halfway.", ...data } });

const suggestions = () =>
  prisma.supportTriageSuggestion.findMany({
    where: { feedbackId: { startsWith: "fb-w-" } },
    orderBy: [{ feedbackId: "asc" }, { createdAt: "asc" }],
    select: { feedbackId: true, state: true, lane: true, keywordFlags: true, claimToken: true },
  });

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a pass makes one ready suggestion per eligible report, with its lane and flags", async () => {
  await report("bug");
  await report("refund", { type: "other", message: "I was charged twice, please refund me." });
  await report("trust", { type: "billing", message: "Refund me and delete my account." });
  await report("verified", { errorReportVerification: "verified" });
  const result = await runSupportTriageWorker();
  assert.equal(result.outcome, "success");
  assert.equal(result.claimed, 4);
  assert.equal(result.ready, 4);
  assert.equal(result.stale, 0);
  assert.deepEqual(
    (await suggestions()).map((s) => [s.feedbackId, s.state, s.lane, s.keywordFlags, s.claimToken]),
    [
      ["fb-w-bug", "ready", "bug_unverified", [], null],
      ["fb-w-refund", "ready", "billing_human", ["money"], null],
      ["fb-w-trust", "ready", "trust_safety_human", ["money", "account_privacy"], null],
      ["fb-w-verified", "ready", "bug_verified", [], null],
    ]
  );
  const actions = (await prisma.adminAuditLog.findMany({ orderBy: { createdAt: "asc" }, select: { action: true } })).map(
    (a) => a.action
  );
  assert.deepEqual(actions, [
    "support_triage.run_started",
    "support_triage.worker_claim",
    "support_triage.worker_result",
    "support_triage.run_finished",
  ]);
  // No report text, digest or report id in any audit entry.
  const audits = JSON.stringify(await prisma.adminAuditLog.findMany({ select: { summary: true, metadata: true, targetId: true } }));
  for (const forbidden of ["charged twice", "fb-w-", "delete my account"]) assert.ok(!audits.includes(forbidden), forbidden);
});

test("closed reports and a deleted account's report get no suggestion", async () => {
  await report("closed", { status: "resolved" });
  await report("deleted", { message: "[deleted account]" });
  await report("open");
  const result = await runSupportTriageWorker();
  assert.equal(result.claimed, 1);
  assert.deepEqual((await suggestions()).map((s) => s.feedbackId), ["fb-w-open"]);
});

test("a second pass over unchanged reports does nothing; a changed input supersedes", async () => {
  await report("a");
  await runSupportTriageWorker();
  const second = await runSupportTriageWorker();
  assert.equal(second.claimed, 0);
  assert.equal((await suggestions()).length, 1);
  // An operator changes the type: the input digest changes.
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { type: "feature" } });
  const third = await runSupportTriageWorker();
  assert.equal(third.superseded, 1);
  assert.deepEqual(
    (await suggestions()).map((s) => [s.state, s.lane]),
    [
      ["superseded", "bug_unverified"],
      ["ready", "feature_request"],
    ]
  );
});

test("a result whose claim was lost is not written and is counted stale", async () => {
  await report("a");
  const run = await startSupportTriageRun("worker");
  const batch = await claimSupportTriageBatch(run, ["fb-w-a"]);
  assert.equal(batch.claimed.length, 1);
  // The lease expires and another pass reclaims and claims the row.
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageSuggestion" DISABLE TRIGGER "SupportTriageSuggestion_guard"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "SupportTriageSuggestion" SET "claimToken" = 'someone-else' WHERE "feedbackId" = 'fb-w-a'`
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageSuggestion" ENABLE TRIGGER "SupportTriageSuggestion_guard"`);
  }
  const { ready, stale, groups } = await writeSupportTriageResults(run, batch.token as string, batch.claimed);
  assert.deepEqual({ ready, stale }, { ready: 0, stale: 1 });
  assert.equal(groups.groupsCreated, 0);
  assert.equal((await suggestions())[0].state, "claimed");
});

test("a report closed between claim and result is not written", async () => {
  await report("a");
  const run = await startSupportTriageRun("worker");
  const batch = await claimSupportTriageBatch(run, ["fb-w-a"]);
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { status: "closed" } });
  const { ready, stale } = await writeSupportTriageResults(run, batch.token as string, batch.claimed);
  assert.deepEqual({ ready, stale }, { ready: 0, stale: 1 });
});

test("expired claims return to pending and are claimed again; after the last attempt they fail", async () => {
  await report("a");
  await report("b");
  const run = await startSupportTriageRun("worker");
  await claimSupportTriageBatch(run, ["fb-w-a", "fb-w-b"]);
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageSuggestion" DISABLE TRIGGER "SupportTriageSuggestion_guard"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "SupportTriageSuggestion" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second',
              "attemptCount" = CASE WHEN "feedbackId" = 'fb-w-b' THEN 3 ELSE 0 END`
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageSuggestion" ENABLE TRIGGER "SupportTriageSuggestion_guard"`);
  }
  const result = await runSupportTriageWorker();
  assert.equal(result.reclaimed, 1);
  assert.equal(result.exhausted, 1);
  const rows = await prisma.supportTriageSuggestion.findMany({
    where: { feedbackId: { startsWith: "fb-w-" } },
    orderBy: { feedbackId: "asc" },
    select: { feedbackId: true, state: true, attemptCount: true, failureCode: true },
  });
  assert.deepEqual(rows, [
    { feedbackId: "fb-w-a", state: "ready", attemptCount: 1, failureCode: null },
    { feedbackId: "fb-w-b", state: "failed", attemptCount: 3, failureCode: "retry_exhausted" },
  ]);
});

test("the run route answers enabled false and writes nothing while triage is off", async () => {
  await report("a");
  const SECRET = "w".repeat(40);
  const post = (secret: string) =>
    new Request("https://example.invalid/api/internal/support-triage/run", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
  assert.deepEqual(await handleSupportTriageRun(post("x".repeat(40)), { env: { SUPPORT_TRIAGE_RUN_SECRET: SECRET } }), {
    status: 401,
    body: { result: "unauthorized" },
  });
  assert.deepEqual(await handleSupportTriageRun(post(SECRET), { env: { SUPPORT_TRIAGE_RUN_SECRET: SECRET } }), {
    status: 200,
    body: { result: "ok", enabled: false },
  });
  assert.equal(await prisma.supportTriageRun.count(), 0);
  assert.equal((await suggestions()).length, 0);
  const on = await handleSupportTriageRun(post(SECRET), {
    env: { SUPPORT_TRIAGE_RUN_SECRET: SECRET, SUPPORT_TRIAGE_ENABLED: "true" },
  });
  assert.equal(on.status, 200);
  assert.deepEqual(Object.keys(on.body).sort(), ["claimed", "enabled", "exhausted", "outcome", "ready", "reclaimed", "result", "stale", "superseded"]);
  assert.equal(on.body.ready, 1);
});

test("an input that comes back gets a new suggestion, and the other input's proposal is superseded", async () => {
  await report("a");
  await runSupportTriageWorker();
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { type: "feature" } });
  await runSupportTriageWorker();
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { type: "bug" } });
  const result = await runSupportTriageWorker();
  assert.equal(result.superseded, 1);
  assert.equal(result.ready, 1);
  assert.deepEqual(
    (await suggestions()).map((s) => [s.state, s.lane]),
    [
      ["superseded", "bug_unverified"],
      ["superseded", "feature_request"],
      ["ready", "bug_unverified"],
    ]
  );
  // Settled: a further pass does nothing.
  assert.equal((await runSupportTriageWorker()).claimed, 0);
});

test("a result for an input changed after the claim is not written; the next pass proposes for the new input", async () => {
  await report("a");
  const run = await startSupportTriageRun("worker");
  const batch = await claimSupportTriageBatch(run, ["fb-w-a"]);
  assert.equal(batch.claimed[0].lane, "bug_unverified");
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { message: "Please delete my account." } });
  const { ready, stale } = await writeSupportTriageResults(run, batch.token as string, batch.claimed);
  assert.deepEqual({ ready, stale }, { ready: 0, stale: 1 });
  await runSupportTriageWorker();
  const live = (await suggestions()).filter((s) => s.state === "ready");
  assert.deepEqual(live.map((s) => s.lane), ["trust_safety_human"]);
});

test("an input that comes back after it was decided or failed is not proposed again", async () => {
  await report("a");
  await runSupportTriageWorker();
  // A person accepts the proposal for input A.
  await prisma.supportTriageSuggestion.updateMany({ where: { feedbackId: "fb-w-a" }, data: { state: "accepted" } });
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { type: "feature" } });
  await runSupportTriageWorker();
  await prisma.feedback.update({ where: { id: "fb-w-a" }, data: { type: "bug" } });
  const result = await runSupportTriageWorker();
  // B's proposal is superseded; A is already decided, so nothing new opens.
  assert.equal(result.superseded, 1);
  assert.equal(result.ready, 0);
  assert.deepEqual(
    (await suggestions()).map((s) => [s.state, s.lane]),
    [
      ["accepted", "bug_unverified"],
      ["superseded", "feature_request"],
    ]
  );
});
