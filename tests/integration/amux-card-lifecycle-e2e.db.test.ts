import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Session } from "next-auth";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, fixtureCommitted, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// One v22 implement card, end to end, on PostgreSQL with every trigger on:
//
//   the worker's run settles the card in review (the fixture walks the real
//   transitions) -> the publisher's pull request is bound to that run ->
//   GitHub, as the approval observer reads it -> the card is done.
//
// GitHub is the only fake: what the observer's read port returns. Each
// scenario is one way this stopped in production during 2026-11, so a change
// that brings one back fails here in seconds instead of on a released card.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-card-lifecycle-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });

/** The product's services, loaded once and only after the harness is in place. */
const services = async () => ({
  ...(await import("@/lib/engineeringAgentPrObserver")),
  ...(await import("@/lib/engineeringAgentGitHubRead")),
  ...(await import("@/lib/amux/legacyCardOwnerService")),
});
type ObservedPull = import("@/lib/engineeringAgentGitHubRead").EngineeringAgentPullObservation;

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "e".repeat(40);
const DIFF = "d".repeat(64);
const APPROVER = 60078951;
const at = (seconds: number) => new Date(Date.now() + seconds * 1_000);

const owner = () => ({
  user: { id: `lifecycle-owner-${randomUUID()}`, email: "amux-lifecycle-owner@example.test",
    authenticatedAt: new Date().toISOString() },
  expires: at(3_600).toISOString(),
}) as Session;
const request = () => new Request("https://tomverse.test/api/admin/amux/legacy-card", {
  method: "POST", headers: { "user-agent": "synthetic-card-lifecycle" } });

type Card = { taskId: string; attemptId: string; runId: string; bindingId: string; prNumber: number;
  escalationId: string };

/**
 * A card the worker's run left in review, with the pull request the publisher
 * opened for that run. The AMUX side is the fixture's real transitions; the
 * engineering run and binding are placed as the publisher's result leaves them.
 */
async function publishedCard(tx: LifecycleTx): Promise<Card> {
  const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx),
    { taskRole: "implement", settlementReason: "review_server_accepted" }) as {
    taskId: string; priorAttemptId: string };
  const runId = String(810_000_000 + Math.floor(Math.random() * 90_000_000));
  const bindingId = randomUUID();
  const prNumber = 900_000 + Math.floor(Math.random() * 90_000);
  const escalationId = randomUUID();
  // The agent's switches as production has them: publishing on, nothing frozen, no AMUX incident.
  for (const [key, value] of [["feature.engineeringAgentMode", "t1"],
    ["amux.incidentMode", JSON.stringify({ version: 1, state: "normal", transition_id: null,
      changed_at: new Date().toISOString(), reason: "card lifecycle fixture", ticket: "TEST" })]] as const) {
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  await tx.appSetting.deleteMany({ where: { key: "feature.engineeringAgentFreeze" } });
  await tx.$executeRaw`INSERT INTO "AmuxHumanEscalation"
    ("id", "taskId", "specialty", "reason", "status", "openedBy", "openedTaskRevision", "updatedAt")
    VALUES (${escalationId}, ${seed.taskId}, 'code-review', 'human_review_required', 'open',
      'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`;
  await withoutTriggers(tx, async () => {
    await tx.$executeRaw`INSERT INTO "EngineeringAgentRun"
      ("id", "amuxAttemptId", "cardId", "cardKind", "baseSha", "status", "outcome", "halt", "modeAtStart",
       "startedAt", "endedAt", "leaseExpiresAt")
      VALUES (${runId}, ${seed.priorAttemptId}, ${seed.taskId}, 'task', ${BASE}, 'finished', 't1_queued',
        'none', 't1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "EngineeringAgentBinding"
      ("id", "runId", "prNumber", "headSha", "verifiedHeadSha", "ref", "snapshot", "currentPrNumber", "updatedAt")
      VALUES (${bindingId}, ${runId}, ${prNumber}, ${HEAD}, ${HEAD}, ${`agent/engineering/${runId}`},
        ${JSON.stringify({ baseSha: BASE, diffDigest: DIFF, treeId: "f".repeat(40),
          invalidatedReviewIds: [] })}::jsonb, ${prNumber}, CURRENT_TIMESTAMP)`;
  });
  await fixtureCommitted(tx);
  return { taskId: seed.taskId, attemptId: seed.priorAttemptId, runId, bindingId, prNumber, escalationId };
}

type Pull = ObservedPull;

const openPull = (over: Record<string, unknown> = {}) => ({
  state: "open", merged: false, mergedAt: null, mergeCommitSha: null, mergedByKind: "unknown",
  mergedByApprover: false, baseRef: "develop", baseSha: BASE, headSha: HEAD, reviews: [],
  requiredChecks: { allPassed: true }, diffDigest: DIFF, changedFiles: null, ...over,
}) as unknown as Pull;
const mergedPull = (over: Record<string, unknown> = {}) => openPull({ state: "closed", merged: true,
  mergedAt: at(180), mergeCommitSha: MERGE, mergedByKind: "user", changedFiles: ["lib/ordinary.ts"], ...over });

/** One observer round; other suites' bindings, if any are left open, read as untouched open pull requests. */
async function observe(card: Card, read: () => Pull | Promise<Pull>, nowSeconds = 240) {
  const { observeEngineeringAgentPullRequests } = await services();
  const outcomes = await observeEngineeringAgentPullRequests({
    read: async (prNumber: number) => prNumber === card.prNumber ? read() : openPull(),
    now: () => at(nowSeconds),
  });
  return outcomes.find((entry) => entry.bindingId === card.bindingId) ?? null;
}

const cardRow = (tx: LifecycleTx, card: Card) => tx.amuxWorkItem.findUniqueOrThrow({ where: { id: card.taskId },
  select: { status: true, revision: true, v4TerminalAt: true, archivedAt: true } });
const escalationRow = (tx: LifecycleTx, card: Card) => tx.amuxHumanEscalation.findUniqueOrThrow({
  where: { id: card.escalationId }, select: { status: true, resolutionOutcome: true, resolution: true } });
const bindingRow = (tx: LifecycleTx, card: Card) => tx.engineeringAgentBinding.findUniqueOrThrow({
  where: { id: card.bindingId }, select: { approvalObservation: true, mergeObservation: true } });
const openMismatches = (tx: LifecycleTx, card: Card) => tx.engineeringAgentWorkItem.count({
  where: { kind: "state_mismatch", state: "open", OR: [{ runId: card.runId },
    { causeKey: { endsWith: `:${card.bindingId}` } }] } });

after(async () => { await closeLifecycleHarness(); });

test("the owner merges the agent's pull request without a separate review: the card is done and nothing stops", async () => {
  // 2026-11-10 #3702 and 2026-11-11 #3747: this was merged_without_approval,
  // which stopped the agent and left the card in review with no decision.
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    assert.equal((await cardRow(tx, card)).status, "review");

    const outcome = await observe(card, () => mergedPull({ mergedByApprover: true }));
    assert.deepEqual(outcome, { bindingId: card.bindingId, outcome: "completed" });

    const done = await cardRow(tx, card);
    assert.equal(done.status, "done");
    assert.equal(done.revision, 5);
    assert.ok(done.v4TerminalAt);
    const escalation = await escalationRow(tx, card);
    assert.equal(escalation.status, "resolved");
    assert.equal(escalation.resolutionOutcome, "approve");
    assert.match(escalation.resolution ?? "", /^The authorised approver merged it themselves and merge e{40} observed\.$/);
    const binding = await bindingRow(tx, card);
    assert.equal((binding.mergeObservation as { merged: boolean }).merged, true);
    assert.equal(binding.approvalObservation, null);
    assert.equal(await openMismatches(tx, card), 0);
    // The engineering side's own audit says the merge stood as the approval.
    const observed = await tx.adminAuditLog.findMany({
      where: { targetType: "engineering_agent_binding", targetId: card.bindingId } });
    assert.equal(observed.some((entry) =>
      (entry.metadata as { approvedByMerge?: boolean } | null)?.approvedByMerge === true), true);
    const audit = await tx.adminAuditLog.findFirstOrThrow({
      where: { action: "amux.v22.review.merge_observed", targetId: card.taskId } });
    assert.equal((audit.metadata as { approval_basis?: string }).approval_basis, "approver_merge");
  });
});

test("a review recorded before the merge completes the card on that review", async () => {
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const review = { id: 9, userId: APPROVER, login: "mposition", state: "APPROVED", commitId: HEAD,
      submittedAt: at(60) };
    // Open and approved: the approval is recorded, the card waits for the merge.
    assert.equal((await observe(card, () => openPull({ reviews: [review] }), 120))?.outcome, "approved");
    assert.equal((await cardRow(tx, card)).status, "review");
    assert.equal(((await bindingRow(tx, card)).approvalObservation as { verdict: string }).verdict, "approved");
    // Merged afterwards, by anyone: the recorded review is the approval.
    assert.equal((await observe(card, () => mergedPull({ reviews: [review] })))?.outcome, "completed");
    assert.equal((await cardRow(tx, card)).status, "done");
    assert.match((await escalationRow(tx, card)).resolution ?? "", /^GitHub approval review 9 and merge /);
  });
});

test("a merge by anyone else with no review still stops the agent and leaves the card for a person", async () => {
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const outcome = await observe(card, () => mergedPull({ mergedByApprover: false }));
    assert.equal(outcome?.outcome, "merged_without_approval");
    assert.equal((await cardRow(tx, card)).status, "review");
    assert.equal((await escalationRow(tx, card)).status, "open");
    // The mismatch really opens: until 2026-11-12 its cause key was longer than
    // the store admits, so this write failed and the whole round with it.
    assert.equal(await openMismatches(tx, card), 1);
    assert.equal(((await bindingRow(tx, card)).mergeObservation as { merged: boolean }).merged, true);
  });
  // An approver's merge of a change the app did not verify is not that
  // approval either: another head whose pull request diff is not the verified
  // one, or whose diff could not be read.
  for (const diffDigest of ["e".repeat(64), null]) {
    await lifecycle(async (tx) => {
      const card = await publishedCard(tx);
      const outcome = await observe(card, () =>
        mergedPull({ mergedByApprover: true, headSha: "a".repeat(40), diffDigest }));
      assert.equal(outcome?.outcome, "merged_without_approval");
      assert.equal((await cardRow(tx, card)).status, "review");
    });
  }
});

test("an approver's merge of a branch brought up to date still counts: same diff, later head", async () => {
  // #3828, 2026-11-13: develop was merged into the branch before the owner
  // merged it. The head moved; what the pull request changes did not.
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const outcome = await observe(card, () =>
      mergedPull({ mergedByApprover: true, headSha: "a".repeat(40), diffDigest: DIFF }));
    assert.equal(outcome?.outcome, "completed");
    assert.equal((await cardRow(tx, card)).status, "done");
  });
});

test("a round that cannot read GitHub decides nothing and says why; the next one finishes the card", async () => {
  // Production 2026-11-11: merged pull requests stayed unobserved with nothing in any log.
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const { EngineeringAgentGitHubReadError } = await services();
    const unreadable = await observe(card, () => { throw new EngineeringAgentGitHubReadError("http_error"); });
    assert.deepEqual(unreadable, { bindingId: card.bindingId, outcome: "unreadable", code: "http_error" });
    assert.equal((await cardRow(tx, card)).status, "review");
    assert.equal((await bindingRow(tx, card)).mergeObservation, null);
    assert.equal(await openMismatches(tx, card), 0);

    assert.equal((await observe(card, () => mergedPull({ mergedByApprover: true })))?.outcome, "completed");
    assert.equal((await cardRow(tx, card)).status, "done");
  });
});

test("the owner settles the card first: the later merge is recorded and nothing stops", async () => {
  // Owner decision 2026-11-12: the owner completes any stopped card directly.
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const { completeAmuxStoppedCardWithin } = await services();
    const settled = await completeAmuxStoppedCardWithin(tx, { session: owner(), request: request(),
      taskId: card.taskId, revision: 4, reason: "Merged it myself; the work is on develop." });
    assert.equal(settled.outcome, "completed");
    assert.equal((await escalationRow(tx, card)).resolutionOutcome, "approve");

    const outcome = await observe(card, () => mergedPull({ mergedByApprover: true }));
    assert.equal(outcome?.outcome, "merge_recorded");
    const done = await cardRow(tx, card);
    assert.equal(done.status, "done");
    assert.equal(done.revision, 5);
    assert.equal(((await bindingRow(tx, card)).mergeObservation as { merged: boolean }).merged, true);
    assert.equal(await openMismatches(tx, card), 0);
  });
});

test("the Decision Maker approves the review draft from the owner queue: recorded only, and the approver's merge still completes the card", async () => {
  // Owner decision 2026-11-13 (S1): the approval is kept for the merge lane;
  // the card waits in review with its escalation open until the merge.
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const patch = ["diff --git a/lib/ordinary.ts b/lib/ordinary.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    await withoutTriggers(tx, () => tx.$executeRaw`INSERT INTO "EngineeringAgentWorkItem"
      ("id", "kind", "state", "causeKey", "runId", "patchBody", "patchDigest", "baseSha", "expectedTreeId",
       "updatedAt", "closedAt")
      VALUES (${randomUUID()}, 'publish', 'published', ${`publish_review:${card.runId}`}, ${card.runId}, ${patch},
        ${createHash("sha256").update(patch, "utf8").digest("hex")}, ${BASE}, ${"f".repeat(40)},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    const { recordDecisionMakerSwitchByOperator } = await import("@/lib/amux/decisionMakerSwitchStore");
    await recordDecisionMakerSwitchByOperator(tx, { session: owner(), scope: "kill_switch", value: "off" });
    await fixtureCommitted(tx);
    const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES } = await import("@/lib/amux/dbBoundary");
    const { readAmuxDmOwnerSettlementSyncRows, applyAmuxDmOwnerSettlementDecision } =
      await import("@/lib/amux/dmOwnerSettlementService");
    const { amuxDmOwnerSettlementId } = await import("@/lib/amux/dmOwnerSettlementCore");
    const settlementId = amuxDmOwnerSettlementId(card.escalationId);
    const rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementSync,
      (inner) => readAmuxDmOwnerSettlementSyncRows(inner, { enabled: true }));
    const filed = rows.pending.find((row) => row.settlementId === settlementId);
    assert.equal(filed?.kind, "t2_pr");
    assert.equal(filed?.bindingId, card.bindingId);
    const applied = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
      (inner, context) => applyAmuxDmOwnerSettlementDecision(inner, { settlementId, answer: { decision: "approve" },
        source: "dm", requestId: "req-lifecycle-approve", now: context.dbNow }));
    assert.deepEqual(applied, { applied: true, outcome: "approved" });
    const [recorded] = await tx.$queryRaw<Array<{ state: string; approvedHeadSha: string; approvedDiffDigest: string }>>`
      SELECT "state", "approvedHeadSha", "approvedDiffDigest" FROM "AmuxDmOwnerSettlement" WHERE "id" = ${settlementId}`;
    assert.deepEqual(recorded, { state: "applied", approvedHeadSha: HEAD, approvedDiffDigest: DIFF });
    assert.equal((await cardRow(tx, card)).status, "review", "the approval alone changes nothing");
    assert.equal((await escalationRow(tx, card)).status, "open");

    assert.equal((await observe(card, () => mergedPull({ mergedByApprover: true })))?.outcome, "completed");
    assert.equal((await cardRow(tx, card)).status, "done");
    const after = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementSync,
      (inner) => readAmuxDmOwnerSettlementSyncRows(inner, { enabled: true }));
    assert.ok(!after.pending.some((row) => row.taskId === card.taskId), "a done card is not filed again");
    assert.equal(await openMismatches(tx, card), 0);
  });
});

test("the Decision Maker's approval, readied by the app and merged by the merge lane into develop, completes the card", async () => {
  // Owner decision 2026-11-13 (S2): "develop 병합 권한은 DM에게 승인합니다. main은
  // 안됩니다." The approval -> the app marks the draft ready -> the lane is told
  // of it and merges it through its own instruction -> the observer reads the
  // bot's merge as the lane's and completes the card on the approval. GitHub
  // is the only fake.
  const ON = { TOMVERSE_AMUX_DM_T2_MERGE: "enabled" };
  // Every module first: a transaction the services leave bounded by their idle
  // timeouts must not wait on a module's first load.
  const { handleQaReleaseMergeLaneState } = await import("@/lib/qaReleaseMergeLaneRoutes");
  const { runAmuxDmT2MergeReadyStep, readAmuxDmT2MergeObserved } = await import("@/lib/amux/dmT2MergeService");
  const { recordDecisionMakerSwitchByOperator } = await import("@/lib/amux/decisionMakerSwitchStore");
  const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES } = await import("@/lib/amux/dbBoundary");
  const { readAmuxDmOwnerSettlementSyncRows, applyAmuxDmOwnerSettlementDecision } =
    await import("@/lib/amux/dmOwnerSettlementService");
  const { amuxDmOwnerSettlementId } = await import("@/lib/amux/dmOwnerSettlementCore");
  const { observeEngineeringAgentPullRequests } = await services();
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const patch = ["diff --git a/lib/ordinary.ts b/lib/ordinary.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    await withoutTriggers(tx, () => tx.$executeRaw`INSERT INTO "EngineeringAgentWorkItem"
      ("id", "kind", "state", "causeKey", "runId", "patchBody", "patchDigest", "baseSha", "expectedTreeId",
       "updatedAt", "closedAt")
      VALUES (${randomUUID()}, 'publish', 'published', ${`publish_review:${card.runId}`}, ${card.runId}, ${patch},
        ${createHash("sha256").update(patch, "utf8").digest("hex")}, ${BASE}, ${"f".repeat(40)},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await recordDecisionMakerSwitchByOperator(tx, { session: owner(), scope: "kill_switch", value: "off" });
    await fixtureCommitted(tx);
    const settlementId = amuxDmOwnerSettlementId(card.escalationId);
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementSync,
      (inner) => readAmuxDmOwnerSettlementSyncRows(inner, { enabled: true }));
    assert.deepEqual(await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
      (inner, context) => applyAmuxDmOwnerSettlementDecision(inner, { settlementId, answer: { decision: "approve" },
        source: "dm", requestId: "req-lifecycle-dm-merge", now: context.dbNow, env: ON })),
    { applied: true, outcome: "approved" });

    // The app marks the draft ready, beside an empty line.
    const ref = `agent/engineering/${card.runId}`;
    const readied: number[] = [];
    const step = await runAmuxDmT2MergeReadyStep({ env: ON, room: true,
      drafts: [{ number: card.prNumber, head: ref, headSha: HEAD, base: "develop", draft: true }],
      ports: {
        pull: async (number) => ({ open: true, pull: { number, nodeId: "PR_node", title: "t", base: "develop", head: ref,
          headSha: HEAD, draft: true, fork: false, labels: [] } }),
        change: async () => ({ state: "open", baseRef: "develop", headRef: ref, headSha: HEAD, diffDigest: DIFF,
          changedFiles: ["lib/ordinary.ts"] }),
        markReady: async (pull) => { readied.push(pull.number); },
      } });
    assert.equal(step.outcome, "marked_ready");
    assert.deepEqual(readied, [card.prNumber]);

    // The lane is told of it with its state. Its attempt is placed as the lane's
    // instruction, consume and report leave it: the operator control those calls
    // need is audited under the top transaction's own id, which no savepoint of
    // this harness has (tests/integration/qa-release-merge-lane-routes.db.test.ts
    // runs those calls against a committing database).
    const LANE = "l".repeat(40);
    const laneEnv = { ...ON, QA_RELEASE_MERGE_LANE_SECRET: LANE, QA_RELEASE_MONITOR_SECRET: "m".repeat(40) };
    const state = await handleQaReleaseMergeLaneState(new Request(
      "https://staging.tomverse.app/api/internal/agents/qa-release/merge-lane/state",
      { method: "POST", headers: { authorization: `Bearer ${LANE}`, "content-type": "application/json" }, body: "{}" }),
    laneEnv);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.deepEqual((state.body.dmApproved as unknown[]).filter((entry) =>
      (entry as { number: number }).number === card.prNumber), [{ number: card.prNumber, headSha: HEAD, headRef: ref }]);
    const attemptId = randomUUID();
    await withoutTriggers(tx, () => tx.$executeRaw`INSERT INTO "QaReleaseMergeAttempt"
      ("id", "pullRequestNumber", "headSha", "base", "controlRevision", "state", "lastAuditLogId", "consumedAt")
      VALUES (${attemptId}, ${card.prNumber}, ${HEAD}, 'develop', 1, 'consumed', ${randomUUID()}, now())`);
    // Merged before the lane reports: the observer waits rather than stop the agent.
    const botMerge = () => mergedPull({ mergedByKind: "bot", mergedByApprover: false });
    const dmMerge = (input: Parameters<typeof readAmuxDmT2MergeObserved>[0]) => readAmuxDmT2MergeObserved(input, ON);
    const observeDm = async () => {
      const outcomes = await observeEngineeringAgentPullRequests({ now: () => at(240), dmMerge,
        read: async (prNumber: number) => prNumber === card.prNumber ? botMerge() : openPull() });
      return outcomes.find((entry) => entry.bindingId === card.bindingId) ?? null;
    };
    assert.equal((await observeDm())?.outcome, "waiting");
    assert.equal(await openMismatches(tx, card), 0);
    assert.equal((await cardRow(tx, card)).status, "review");
    // The lane reports its merge commit.
    await withoutTriggers(tx, () => tx.$executeRaw`UPDATE "QaReleaseMergeAttempt"
      SET "state" = 'awaiting_deploy', "mergeCommitSha" = ${MERGE} WHERE "id" = ${attemptId}`);

    assert.equal((await observeDm())?.outcome, "completed");
    assert.equal((await cardRow(tx, card)).status, "done");
    assert.equal((await escalationRow(tx, card)).resolutionOutcome, "approve");
    assert.equal(await openMismatches(tx, card), 0);
    const audit = await tx.adminAuditLog.findFirstOrThrow({ where: { targetId: card.taskId,
      action: "amux.v22.review.merge_observed" }, select: { metadata: true } });
    assert.equal((audit.metadata as { approval_basis?: string }).approval_basis, "dm_approval");
    assert.equal((audit.metadata as { dm_settlement_id?: string }).dm_settlement_id, settlementId);
  });
});

test("a bot's merge of a Decision Maker approved pull request that the lane never merged still stops the agent", async () => {
  const ON = { TOMVERSE_AMUX_DM_T2_MERGE: "enabled" };
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    const { readAmuxDmT2MergeObserved } = await import("@/lib/amux/dmT2MergeService");
    const { observeEngineeringAgentPullRequests } = await services();
    const outcomes = await observeEngineeringAgentPullRequests({ now: () => at(240),
      dmMerge: (input) => readAmuxDmT2MergeObserved(input, ON),
      read: async (prNumber: number) => prNumber === card.prNumber ?
        mergedPull({ mergedByKind: "bot", mergedByApprover: false }) : openPull() });
    assert.equal(outcomes.find((entry) => entry.bindingId === card.bindingId)?.outcome, "merged_without_approval");
    assert.equal((await cardRow(tx, card)).status, "review");
    assert.equal(await openMismatches(tx, card), 1);
  });
});

test("the harness checks what a commit checks: a write only a deferred trigger refuses is refused", async () => {
  // The lifecycle would prove nothing if a row production refuses at commit
  // slipped through its one outer transaction. A card that loses its v22
  // receipt passes every immediate check and fails only the deferred receipt
  // guard, at the end of the service's own transaction.
  const { prisma } = await import("@/lib/prisma");
  await lifecycle(async (tx) => {
    const card = await publishedCard(tx);
    let reached = false;
    await assert.rejects(prisma.$transaction(async (inner) => {
      await inner.$executeRaw`UPDATE "AmuxWorkItem" SET "v22ReceiptId" = NULL WHERE "id" = ${card.taskId}`;
      reached = true;
    }), /promotion receipt is not bound|AmuxV22PromotionReceipt_binding_check/);
    assert.equal(reached, true, "the write itself passed; only the commit-time check refused it");
    // Rolled back to before that transaction, as a failed commit leaves it.
    const [row] = await tx.$queryRaw<Array<{ bound: boolean }>>`
      SELECT "v22ReceiptId" IS NOT NULL AS "bound" FROM "AmuxWorkItem" WHERE "id" = ${card.taskId}`;
    assert.equal(row?.bound, true);
  });
});
