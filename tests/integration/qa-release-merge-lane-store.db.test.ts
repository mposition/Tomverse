import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { prisma } from "@/lib/prisma";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import {
  QaReleaseMergeLaneLate,
  consumeQaReleaseMergeInstruction,
  issueQaReleaseMergeInstruction,
  reportQaReleaseMergeResult,
} from "@/lib/qaReleaseMergeLaneStore";
import { releaseQaReleaseMergeLaneLatch } from "@/lib/qaReleaseMergeLaneRelease";

// The merge lane's single writer against PostgreSQL: instruction issue.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = { user: { id: "qa-lane-store-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const HEAD = "e".repeat(40);
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

const recordControl = async (developLaneOn: boolean) =>
  (revision = (
    await recordQaReleaseOperatorControl({
      session: session as never,
      control: {
        digestEnabled: false,
        mergeLaneEnabled: true,
        developLaneOn,
        iacCommit: null,
        digestSecretRotatedAt: null,
        monitorSecretRotatedAt: null,
        mergeLaneSecretRotatedAt: null,
        githubAppKeyRotatedAt: null,
        railwayTokenRotatedAt: null,
        githubReadTokenRotatedAt: null,
      },
    })
  ).revision);

beforeEach(async () => {
  await cleanup();
  await recordControl(true);
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const budget = (overrides: Partial<{ startedAt: number; budgetMs: number; clock: () => number }> = {}) => ({
  startedAt: Date.now(),
  budgetMs: 110_000,
  clock: Date.now,
  ...overrides,
});

const issue = (overrides: Partial<{ callerRevision: number | null; number: number; headSha: string }> = {}) =>
  issueQaReleaseMergeInstruction({
    callerRevision: overrides.callerRevision === undefined ? revision : overrides.callerRevision,
    pullRequest: { number: overrides.number ?? 21, headSha: overrides.headSha ?? HEAD },
    budget: budget(),
  });

const attempts = () =>
  prisma.qaReleaseMergeAttempt.findMany({ select: { id: true, state: true, controlRevision: true, pullRequestNumber: true } });

test("an instruction opens one attempt under the newest revision, audited by the merge lane", async () => {
  const result = await issue();
  assert.equal(result.issued, true);
  if (!result.issued) return;
  assert.equal(result.controlRevision, revision);
  assert.deepEqual(await attempts(), [{ id: result.attemptId, state: "issued", controlRevision: revision, pullRequestNumber: 21 }]);
  const audit = await prisma.adminAuditLog.findFirst({ where: { targetId: result.attemptId } });
  assert.equal(audit?.action, "qa_release.merge_attempt_issued");
  assert.equal((audit?.metadata as Record<string, unknown>).systemActor, "qa-release-merge-lane");
  assert.ok(result.expiresAt.getTime() > Date.now());
});

test("a second instruction while one is open is refused and writes nothing", async () => {
  assert.equal((await issue()).issued, true);
  assert.deepEqual(await issue({ number: 22 }), { issued: false, reason: "attempt_open" });
  assert.equal((await attempts()).length, 1);
});

test("a stale caller revision, a lane switched off and an invalid pull request are refused", async () => {
  assert.deepEqual(await issue({ callerRevision: revision - 1 }), { issued: false, reason: "revision_mismatch" });
  assert.deepEqual(await issue({ headSha: "xyz" }), { issued: false, reason: "invalid_pull_request" });
  await recordControl(false);
  assert.deepEqual(await issue(), { issued: false, reason: "develop_lane_off" });
  assert.equal((await attempts()).length, 0);
});

test("a latched lane is refused", async () => {
  // Latch the lane the way only the lane may: an audited set event.
  await prisma.$transaction(async (tx) => {
    const auditId = await writeSystemAuditLog({
      tx,
      systemActor: "qa-release-merge-lane",
      action: "qa_release.merge_lane_latched",
      targetType: "QaReleaseMergeLaneLatch",
      targetId: "1",
      summary: "test",
    });
    await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "auditLogId")
      VALUES (1, true, 'deploy_failed', ${auditId})`;
  });
  assert.deepEqual(await issue(), { issued: false, reason: "latched" });
  // A person's release opens it again.
  await prisma.$transaction(async (tx) => {
    const auditId = await writeAdminAuditLog({
      tx,
      session: session as never,
      action: "qa_release.merge_lane_released",
      targetType: "QaReleaseMergeLaneLatch",
      targetId: "2",
      summary: "test",
    });
    await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "auditLogId")
      VALUES (2, false, NULL, ${auditId})`;
  });
  assert.equal((await issue()).issued, true);
});

test("a round past its deadline records nothing", async () => {
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_issued" } });
  await assert.rejects(
    issueQaReleaseMergeInstruction({
      callerRevision: revision,
      pullRequest: { number: 21, headSha: HEAD },
      budget: budget({ budgetMs: 1 }),
    }),
    QaReleaseMergeLaneLate,
  );
  assert.equal((await attempts()).length, 0);
  // The audit row was written inside the rolled-back transaction.
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_issued" } }), auditsBefore);
});

const consume = (attemptId: string, overrides: Partial<{ callerRevision: number; number: number; headSha: string; base: string; budgetMs: number }> = {}) =>
  consumeQaReleaseMergeInstruction({
    callerRevision: overrides.callerRevision ?? revision,
    request: {
      attemptId,
      pullRequestNumber: overrides.number ?? 21,
      headSha: overrides.headSha ?? HEAD,
      base: overrides.base ?? "develop",
    },
    budget: budget(overrides.budgetMs === undefined ? {} : { budgetMs: overrides.budgetMs }),
  });

const issued = async () => {
  const result = await issue();
  if (!result.issued) throw new Error(`not issued: ${result.reason}`);
  return result.attemptId;
};

test("a consume succeeds once, for exactly what was issued, audited by the merge lane", async () => {
  const attemptId = await issued();
  assert.deepEqual(await consume(attemptId), { consumed: true });
  const row = await prisma.qaReleaseMergeAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  assert.equal(row.state, "consumed");
  assert.ok(row.consumedAt);
  assert.equal(
    (await prisma.adminAuditLog.findFirst({ where: { id: row.lastAuditLogId } }))?.action,
    "qa_release.merge_attempt_consumed",
  );
  assert.deepEqual(await consume(attemptId), { consumed: false, reason: "already_consumed" });
});

test("a changed pull request, an unknown attempt and a stale caller are refused and write nothing", async () => {
  const attemptId = await issued();
  assert.deepEqual(await consume(attemptId, { headSha: "f".repeat(40) }), { consumed: false, reason: "binding_mismatch" });
  assert.deepEqual(await consume(attemptId, { base: "main" }), { consumed: false, reason: "binding_mismatch" });
  assert.deepEqual(await consume(attemptId, { number: 99 }), { consumed: false, reason: "binding_mismatch" });
  assert.deepEqual(await consume("no-such-attempt"), { consumed: false, reason: "instruction_unknown" });
  assert.deepEqual(await consume(attemptId, { callerRevision: revision - 1 }), { consumed: false, reason: "revision_mismatch" });
  assert.equal((await prisma.qaReleaseMergeAttempt.findUniqueOrThrow({ where: { id: attemptId } })).state, "issued");
});

test("a revision recorded after issue, even with the switch still on, refuses the consume", async () => {
  const attemptId = await issued();
  await recordControl(true);
  assert.deepEqual(await consume(attemptId), { consumed: false, reason: "revision_moved" });
  await recordControl(false);
  assert.deepEqual(await consume(attemptId), { consumed: false, reason: "revision_moved" });
});

test("an expired instruction is refused on the database clock", async () => {
  const attemptId = await issued();
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseMergeAttempt" DISABLE TRIGGER "QaReleaseMergeAttempt_before_update"`);
  try {
    await prisma.$executeRaw`UPDATE "QaReleaseMergeAttempt" SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${attemptId}`;
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseMergeAttempt" ENABLE TRIGGER "QaReleaseMergeAttempt_before_update"`);
  }
  assert.deepEqual(await consume(attemptId), { consumed: false, reason: "expired" });
});

test("a late consume records nothing", async () => {
  const attemptId = await issued();
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_consumed" } });
  await assert.rejects(consume(attemptId, { budgetMs: 1 }), QaReleaseMergeLaneLate);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_consumed" } }), auditsBefore);
  assert.equal((await prisma.qaReleaseMergeAttempt.findUniqueOrThrow({ where: { id: attemptId } })).state, "issued");
});

const report = (attemptId: string, body: Parameters<typeof reportQaReleaseMergeResult>[0]["report"], overrides: Partial<{ callerRevision: number; budgetMs: number }> = {}) =>
  reportQaReleaseMergeResult({
    callerRevision: overrides.callerRevision ?? revision,
    attemptId,
    report: body,
    budget: budget(overrides.budgetMs === undefined ? {} : { budgetMs: overrides.budgetMs }),
  });

const MERGE_SHA = "9".repeat(40);
const OBS = [{ service: "web", status: "SUCCESS", commitSha: "9".repeat(40) }];
/** A report expected to be recorded, narrowed for its fields. */
const recorded = async (...args: Parameters<typeof report>) => {
  const result = await report(...args);
  if (!result.recorded) throw new Error(`not recorded: ${result.reason}`);
  return result;
};
const attemptRow = (id: string) => prisma.qaReleaseMergeAttempt.findUniqueOrThrow({ where: { id } });
const latchEvents = () => prisma.qaReleaseMergeLaneLatch.findMany({ orderBy: { sequence: "asc" }, select: { latched: true, reason: true, attemptId: true } });
const consumedAttempt = async () => {
  const attemptId = await issued();
  assert.deepEqual(await consume(attemptId), { consumed: true });
  return attemptId;
};

test("a merged report moves the attempt to awaiting deploy with its merge commit, and a deploy success closes it", async () => {
  const attemptId = await consumedAttempt();
  assert.deepEqual(await report(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA }), {
    recorded: true,
    moved: true,
    latched: null,
    revisionMatched: true,
  });
  let row = await attemptRow(attemptId);
  assert.equal(row.state, "awaiting_deploy");
  assert.equal(row.mergeCommitSha, MERGE_SHA);
  // The lane holds while the deploy is outstanding.
  assert.deepEqual(await issue({ number: 30 }), { issued: false, reason: "attempt_open" });
  assert.equal((await report(attemptId, { kind: "deploy", outcome: "succeeded", observation: OBS })).recorded, true);
  row = await attemptRow(attemptId);
  assert.equal(row.state, "closed");
  assert.equal(row.outcome, "deployed");
  assert.deepEqual(await latchEvents(), []);
});

test("a failed deploy closes and latches, queues the day's alert, and the lane stays shut", async () => {
  const attemptId = await consumedAttempt();
  await report(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA });
  assert.deepEqual(await report(attemptId, { kind: "deploy", outcome: "failed", observation: OBS }), {
    recorded: true,
    moved: true,
    latched: "deploy_failed",
    revisionMatched: true,
  });
  assert.equal((await attemptRow(attemptId)).outcome, "deploy_failed");
  assert.deepEqual(await latchEvents(), [{ latched: true, reason: "deploy_failed", attemptId }]);
  const alerts = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_merge_lane_latched" } });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].referenceId, /^merge-lane-latch:\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(await issue({ number: 31 }), { issued: false, reason: "latched" });
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("an unknown merge result latches and keeps the attempt open; a deploy wait keeps it open too", async () => {
  const attemptId = await consumedAttempt();
  assert.deepEqual(await report(attemptId, { kind: "merge", result: "unknown" }), {
    recorded: true,
    moved: false,
    latched: "merge_result_unknown",
    revisionMatched: true,
  });
  assert.equal((await attemptRow(attemptId)).state, "consumed");
  // The re-read then finds it on develop and moves it to awaiting deploy.
  assert.equal((await recorded(attemptId, { kind: "reread", result: "merged_on_develop", mergeCommitSha: MERGE_SHA })).moved, true);
  assert.equal((await recorded(attemptId, { kind: "deploy", outcome: "wait_exceeded", observation: OBS })).latched, "deploy_wait_exceeded");
  assert.equal((await attemptRow(attemptId)).state, "awaiting_deploy");
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("a report from another revision is kept and latches, and never closes a deploy as a success", async () => {
  const attemptId = await consumedAttempt();
  await report(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA });
  await recordControl(true);
  assert.deepEqual(await report(attemptId, { kind: "deploy", outcome: "succeeded", observation: OBS }, { callerRevision: revision - 1 }), {
    recorded: true,
    moved: false,
    latched: "revision_mismatch",
    revisionMatched: false,
  });
  assert.equal((await attemptRow(attemptId)).state, "awaiting_deploy");
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("a report about a state the attempt has left, an unknown attempt, or an early unreported claim records nothing", async () => {
  const attemptId = await issued();
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_reported" } });
  assert.deepEqual(await report(attemptId, { kind: "deploy", outcome: "succeeded", observation: OBS }), { recorded: false, reason: "state_moved" });
  assert.deepEqual(await report("no-such-attempt", { kind: "merge", result: "refused" }), { recorded: false, reason: "attempt_unknown" });
  assert.deepEqual(await report(attemptId, { kind: "unreported" }), { recorded: false, reason: "too_early" });
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_reported" } }), auditsBefore);
  assert.deepEqual(await latchEvents(), []);
  // A refused merge closes it without a latch.
  assert.deepEqual(await consume(attemptId), { consumed: true });
  assert.equal((await recorded(attemptId, { kind: "merge", result: "refused" })).latched, null);
  assert.equal((await attemptRow(attemptId)).outcome, "merge_refused");
});

test("a late report records nothing", async () => {
  const attemptId = await consumedAttempt();
  await assert.rejects(report(attemptId, { kind: "merge", result: "refused" }, { budgetMs: 1 }), QaReleaseMergeLaneLate);
  assert.equal((await attemptRow(attemptId)).state, "consumed");
});

const release = (resolution: Parameters<typeof releaseQaReleaseMergeLaneLatch>[0]["resolution"]) =>
  releaseQaReleaseMergeLaneLatch({ session: session as never, resolution });

test("a person releases a latched lane, and only a latched one, audited as a person", async () => {
  assert.deepEqual(await release(null), { released: false, reason: "not_latched" });
  const attemptId = await consumedAttempt();
  await recorded(attemptId, { kind: "merge", result: "unknown" });
  const result = await release(null);
  assert.equal(result.released, true);
  const events = await latchEvents();
  assert.deepEqual(events.at(-1), { latched: false, reason: null, attemptId: null });
  // The attempt stays open: a latch release never closes it, so the lane still holds.
  assert.equal((await attemptRow(attemptId)).state, "consumed");
  assert.deepEqual(await issue({ number: 40 }), { issued: false, reason: "attempt_open" });
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("a person ends a stuck attempt by what they confirmed, in the same transaction as the release", async () => {
  // Unknown merge result, then the person confirms it landed on develop.
  const placed = await consumedAttempt();
  await recorded(placed, { kind: "merge", result: "unknown" });
  assert.equal((await release({ attemptId: placed, shownState: "consumed", fact: "merged_on_develop", mergeCommitSha: MERGE_SHA })).released, true);
  let row = await attemptRow(placed);
  assert.equal(row.state, "awaiting_deploy");
  assert.equal(row.mergeCommitSha, MERGE_SHA);
  const audit = await prisma.adminAuditLog.findFirst({ where: { id: row.lastAuditLogId } });
  assert.equal(audit?.action, "qa_release.merge_attempt_resolved");
  assert.equal(audit?.actorUserId, session.user.id);

  // The deploy then never resolves; the person confirms staging was restored.
  await recorded(placed, { kind: "deploy", outcome: "unknown", observation: OBS });
  assert.equal((await release({ attemptId: placed, shownState: "awaiting_deploy", fact: "restored" })).released, true);
  row = await attemptRow(placed);
  assert.equal(row.state, "closed");
  assert.equal(row.outcome, "person_restored");
  assert.equal((await issue({ number: 41 })).issued, true);
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("a resolution for a state the attempt has left writes nothing, and the latch stays", async () => {
  const attemptId = await consumedAttempt();
  await recorded(attemptId, { kind: "merge", result: "unknown" });
  const before = await latchEvents();
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_resolved" } });
  // The screen showed "issued"; the attempt is consumed.
  assert.deepEqual(await release({ attemptId, shownState: "issued", fact: "not_merged" }), { released: false, reason: "attempt_changed" });
  assert.deepEqual(await latchEvents(), before);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_resolved" } }), auditsBefore);
  assert.deepEqual(
    await release({ attemptId, shownState: "consumed", fact: "merged_on_develop", mergeCommitSha: "nope" }),
    { released: false, reason: "invalid_resolution" },
  );
  assert.equal((await release({ attemptId, shownState: "consumed", fact: "not_merged" })).released, true);
  assert.equal((await attemptRow(attemptId)).outcome, "person_not_merged");
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("a deploy report records what the lane observed, even when the attempt stays where it is", async () => {
  const attemptId = await consumedAttempt();
  await recorded(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA });
  const waiting = [
    { service: "web", status: "BUILDING", commitSha: MERGE_SHA },
    { service: "worker", status: "SUCCESS", commitSha: "8".repeat(40) },
  ];
  // A wait past its limit latches and keeps the attempt open, with the observation.
  await recorded(attemptId, { kind: "deploy", outcome: "wait_exceeded", observation: waiting });
  let row = await attemptRow(attemptId);
  assert.equal(row.state, "awaiting_deploy");
  assert.deepEqual(row.deployObservation, waiting);
  assert.ok(row.deployObservedAt);
  // A success withheld for another revision still records what was seen.
  await recordControl(true);
  const served = [{ service: "web", status: "SUCCESS", commitSha: MERGE_SHA }];
  const withheld = await recorded(attemptId, { kind: "deploy", outcome: "succeeded", observation: served }, { callerRevision: revision - 1 });
  assert.equal(withheld.moved, false);
  row = await attemptRow(attemptId);
  assert.equal(row.state, "awaiting_deploy");
  assert.deepEqual(row.deployObservation, served);
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("the Admin read shows the latch reason, the attempt id and the observed deployments", async () => {
  const attemptId = await consumedAttempt();
  await recorded(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA });
  const seen = [{ service: "web", status: "FAILED", commitSha: MERGE_SHA }];
  await recorded(attemptId, { kind: "deploy", outcome: "unknown", observation: seen });
  const { mergeLane } = await readAgentDigestConsole(true);
  assert.equal(mergeLane.latched, true);
  assert.equal(mergeLane.latch?.reason, "deploy_unknown");
  assert.equal(mergeLane.latch?.attemptId, attemptId);
  assert.equal(mergeLane.openAttempt?.id, attemptId);
  assert.equal(mergeLane.openAttempt?.state, "awaiting_deploy");
  assert.equal(mergeLane.openAttempt?.pullRequestNumber, 21);
  assert.equal(mergeLane.openAttempt?.mergeCommitSha, MERGE_SHA);
  assert.deepEqual(mergeLane.openAttempt?.deployObservation, seen);
  assert.equal(typeof mergeLane.openAttempt?.deployObservedAt, "string");
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("the same observation reported again is still recorded, and a repeated latch is recorded after a release", async () => {
  const attemptId = await consumedAttempt();
  await recorded(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA });
  const same: { service: string; status: string; commitSha: string | null }[] = [];
  const first = await recorded(attemptId, { kind: "deploy", outcome: "unreadable", observation: same });
  assert.equal(first.latched, "deploy_unreadable");
  const firstSeen = (await attemptRow(attemptId)).deployObservedAt;
  // A person releases the latch only; the attempt stays open and waiting.
  assert.equal((await releaseQaReleaseMergeLaneLatch({ session: session as never, resolution: null })).released, true);
  // The same empty list again: recorded, latched again, the time moved on.
  const again = await recorded(attemptId, { kind: "deploy", outcome: "unreadable", observation: same });
  assert.equal(again.latched, "deploy_unreadable");
  const row = await attemptRow(attemptId);
  assert.equal(row.state, "awaiting_deploy");
  // The same list again still moves the observation time (a release ran in between).
  assert.ok(row.deployObservedAt && firstSeen && row.deployObservedAt.getTime() > firstSeen.getTime());
  assert.deepEqual((await latchEvents()).map((event) => event.latched), [true, false, true]);
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});

test("after a failed deploy the Admin read shows the closed attempt the latch names", async () => {
  const attemptId = await consumedAttempt();
  await recorded(attemptId, { kind: "merge", result: "merged", mergeCommitSha: MERGE_SHA });
  const failed = [{ service: "web", status: "FAILED", commitSha: MERGE_SHA }];
  await recorded(attemptId, { kind: "deploy", outcome: "failed", observation: failed });
  const { mergeLane } = await readAgentDigestConsole(false);
  assert.equal(mergeLane.openAttempt, null);
  assert.equal(mergeLane.latchAttempt?.id, attemptId);
  assert.equal(mergeLane.latchAttempt?.state, "closed");
  assert.equal(mergeLane.latchAttempt?.outcome, "deploy_failed");
  assert.equal(mergeLane.latchAttempt?.pullRequestNumber, 21);
  assert.deepEqual(mergeLane.latchAttempt?.deployObservation, failed);
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_merge_lane_latched" } });
});
