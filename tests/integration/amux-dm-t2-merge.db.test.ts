import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Session } from "next-auth";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, fixtureCommitted, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// The Decision Maker's develop merge (owner decision 2026-11-13: "develop 병합
// 권한은 DM에게 승인합니다. main은 안됩니다."), on PostgreSQL with every
// migration trigger on: an approval recorded from the owner queue is marked
// ready only behind its switch, only beside CI admission's line, only as it
// was approved, audited through the chain writer before the write; a change a
// revert cannot undo is left to a person at the approval itself; the merge
// lane's list and the observer's read follow the same conditions. GitHub is a
// fake port. No TEST_DATABASE_URL: not executed.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-dm-t2-merge-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });

const ON = { TOMVERSE_AMUX_DM_T2_MERGE: "enabled" };

const services = async () => ({
  ...(await import("@/lib/amux/dmOwnerSettlementService")),
  ...(await import("@/lib/amux/dmOwnerSettlementCore")),
  ...(await import("@/lib/amux/dmT2MergeService")),
  ...(await import("@/lib/amux/dbBoundary")),
  ...(await import("@/lib/amux/decisionMakerSwitchStore")),
});

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const DIFF = "d".repeat(64);

const operator = () => ({ user: { id: `dm-t2-operator-${randomUUID()}`, email: "operator@example.test" },
  expires: "2099-01-01T00:00:00.000Z" }) as Session;

type Card = { taskId: string; settlementId: string; bindingId: string; prNumber: number; ref: string };

/** A v22 Task in review with the publisher's review draft for its run, filed as an owner queue settlement. */
async function reviewDraft(tx: LifecycleTx, patch: string): Promise<Card> {
  const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), {
    taskRole: "implement", settlementStatus: "review", settlementReason: "human_review_required" }) as {
    taskId: string; priorAttemptId: string };
  const escalationId = randomUUID();
  const runId = String(840_000_000 + Math.floor(Math.random() * 90_000_000));
  const bindingId = randomUUID();
  const prNumber = 930_000 + Math.floor(Math.random() * 60_000);
  const ref = `agent/engineering/${runId}`;
  await tx.$executeRaw`INSERT INTO "AmuxHumanEscalation"
    ("id", "taskId", "specialty", "reason", "status", "openedBy", "openedTaskRevision", "updatedAt")
    VALUES (${escalationId}, ${seed.taskId}, 'code-review', 'human_review_required', 'open',
      'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`;
  await withoutTriggers(tx, async () => {
    await tx.$executeRaw`INSERT INTO "EngineeringAgentRun"
      ("id", "amuxAttemptId", "cardId", "cardKind", "baseSha", "status", "outcome", "halt", "modeAtStart",
       "startedAt", "endedAt", "leaseExpiresAt")
      VALUES (${runId}, ${seed.priorAttemptId}, ${seed.taskId}, 'task', ${BASE}, 'finished', 't2_draft',
        'none', 't1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "EngineeringAgentWorkItem"
      ("id", "kind", "state", "causeKey", "runId", "patchBody", "patchDigest", "baseSha", "expectedTreeId",
       "updatedAt", "closedAt")
      VALUES (${randomUUID()}, 'publish', 'published', ${`publish_review:${runId}`}, ${runId}, ${patch},
        ${createHash("sha256").update(patch, "utf8").digest("hex")}, ${BASE}, ${"f".repeat(40)},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "EngineeringAgentBinding"
      ("id", "runId", "prNumber", "headSha", "verifiedHeadSha", "ref", "snapshot", "currentPrNumber", "updatedAt")
      VALUES (${bindingId}, ${runId}, ${prNumber}, ${HEAD}, ${HEAD}, ${ref},
        ${JSON.stringify({ baseSha: BASE, diffDigest: DIFF, treeId: "f".repeat(40),
          invalidatedReviewIds: [] })}::jsonb, ${prNumber}, CURRENT_TIMESTAMP)`;
  });
  const { recordDecisionMakerSwitchByOperator, amuxDmOwnerSettlementId, withAmuxDbBoundary, AMUX_DB_BOUNDARIES,
    readAmuxDmOwnerSettlementSyncRows } = await services();
  await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "off" });
  await fixtureCommitted(tx);
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementSync,
    (inner) => readAmuxDmOwnerSettlementSyncRows(inner, { enabled: true }));
  return { taskId: seed.taskId, settlementId: amuxDmOwnerSettlementId(escalationId), bindingId, prNumber, ref };
}

async function approve(card: Card, env: Record<string, string | undefined>) {
  const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES, applyAmuxDmOwnerSettlementDecision } = await services();
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => applyAmuxDmOwnerSettlementDecision(tx, { settlementId: card.settlementId,
      answer: { decision: "approve" }, source: "dm", requestId: `req-${randomUUID().slice(0, 8)}`,
      now: context.dbNow, env }));
}

/** A change wholly inside the Decision Maker merge allow list. */
const ORDINARY = "diff --git a/components/Ordinary.tsx b/components/Ordinary.tsx\n@@ -1 +1 @@\n-a\n+b\n";

/** GitHub as the step reads it: the draft as approved unless told otherwise. */
function github(card: Card, over: { draft?: boolean; headSha?: string; files?: string[]; markReady?: () => void;
  fork?: boolean } = {}) {
  const writes: number[] = [];
  return {
    writes,
    ports: {
      pull: async (prNumber: number) => prNumber !== card.prNumber ? null : ({ open: true, pull: {
        number: prNumber, nodeId: "PR_node", title: "t", base: "develop", head: card.ref,
        headSha: over.headSha ?? HEAD, draft: over.draft ?? true, fork: over.fork ?? false, labels: [] } }),
      change: async () => ({ state: "open" as const, baseRef: "develop", headRef: card.ref,
        headSha: over.headSha ?? HEAD, diffDigest: DIFF, changedFiles: over.files ?? ["components/Ordinary.tsx"],
        crossRepository: over.fork ?? false }),
      markReady: async (pull: { number: number }) => { writes.push(pull.number); over.markReady?.(); },
    },
  };
}
const draftsOf = (card: Card) => [{ number: card.prNumber, head: card.ref, headSha: HEAD, base: "develop", draft: true,
  fork: false }];
/** No pull_request run on GitHub; or this pull request's run at the approved head, queued or in progress. */
const NONE = new Set<string>();
const runningOf = (card: Card) => new Set([`${card.prNumber}@${HEAD}`]);

const readyAudits = (tx: LifecycleTx, settlementId: string) => tx.adminAuditLog.findMany({
  where: { targetId: settlementId, action: "amux.dm_t2_merge.ready_requested" },
  select: { actorUserId: true, entryHash: true, metadata: true } });

after(async () => { await closeLifecycleHarness(); });

test("an approved review draft is marked ready once, audited first, only behind the switch and beside the line", async () => {
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    const { runAmuxDmT2MergeReadyStep } = await services();

    const off = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE, ports: off.ports, env: {} }),
      { outcome: "off" });
    const full = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: false, running: NONE, ports: full.ports, env: ON }),
      { outcome: "no_room" });
    assert.deepEqual([...off.writes, ...full.writes], []);
    assert.equal((await readyAudits(tx, card.settlementId)).length, 0);

    const on = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE, ports: on.ports, env: ON }),
      { outcome: "marked_ready", settlementId: card.settlementId, prNumber: card.prNumber, headSha: HEAD });
    assert.deepEqual(on.writes, [card.prNumber]);
    const audits = await readyAudits(tx, card.settlementId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actorUserId, null, "the system, never a person");
    assert.ok(audits[0]!.entryHash, "through the hash-chained writer");
    assert.deepEqual((audits[0]!.metadata as Record<string, unknown>).headSha, HEAD);
    assert.deepEqual((audits[0]!.metadata as Record<string, unknown>).base, "develop");

    // Its CI not on GitHub yet: the next ready waits, as after a person's ready (one pull request can overflow).
    const held = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE, ports: held.ports,
      env: ON }), { outcome: "in_flight" });
    assert.deepEqual(held.writes, []);
    // Ten minutes on with still no run: the hold is off.
    const later = github(card, { draft: false });
    assert.equal((await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE, ports: later.ports,
      env: ON, nowMs: Date.now() + 10 * 60 * 1000 + 1_000 })).outcome, "already_ready");
    // Already ready, its run shown: nothing more is written.
    const again = github(card, { draft: false });
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: runningOf(card), ports: again.ports, env: ON }),
      { outcome: "already_ready", settlementId: card.settlementId, prNumber: card.prNumber });
    assert.deepEqual(again.writes, []);
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1);

    // The Task, its escalation and the approval are as the approval left them.
    const task = await tx.amuxWorkItem.findUniqueOrThrow({ where: { id: card.taskId }, select: { status: true } });
    assert.equal(task.status, "review");
  });
});

test("a write whose answer is unknown is not retried; a moved head, a changed file list or the kill switch writes nothing", async () => {
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    const { runAmuxDmT2MergeReadyStep, recordDecisionMakerSwitchByOperator } = await services();

    const lost = github(card, { markReady: () => { throw new Error("github_graphql_502"); } });
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE, ports: lost.ports, env: ON }),
      { outcome: "write_unknown", settlementId: card.settlementId, prNumber: card.prNumber, headSha: HEAD,
        code: "github_graphql_502" });
    assert.deepEqual(lost.writes, [card.prNumber], "one call, never a second in the same step");
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1, "audited before the write");
    // An unknown write holds the next ready back like a known one, until its CI shows or ten minutes pass.
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE,
      ports: github(card).ports, env: ON }), { outcome: "in_flight" });

    const cases: Array<[{ headSha?: string; files?: string[] }, string]> = [[{ headSha: "a".repeat(40) }, "head_moved"],
      [{ files: ["components/Ordinary.tsx", "lib/providerCostBudget.ts"] }, "outside_dm_merge_allowlist"]];
    for (const [over, reason] of cases) {
      const moved = github(card, over);
      const step = await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: runningOf(card), ports: moved.ports, env: ON });
      assert.equal(step.outcome, "skipped");
      assert.equal((step as { reason: string }).reason, reason);
      assert.deepEqual(moved.writes, []);
    }
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1);

    // A fork's pull request, as GitHub reads it now: never written.
    const forked = github(card, { fork: true });
    const forkStep = await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: runningOf(card), ports: forked.ports, env: ON });
    assert.equal((forkStep as { reason?: string }).reason, "fork_pr");
    assert.deepEqual(forked.writes, []);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: [{ ...draftsOf(card)[0]!, fork: true }], room: true, running: NONE,
      ports: github(card).ports, env: ON }), { outcome: "none" }, "a fork in CI admission's own list is not even picked");
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1);

    await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "on" });
    const killed = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: runningOf(card), ports: killed.ports, env: ON }),
      { outcome: "none" }, "the one judgment reads the kill switch at the pick: nothing is picked");
    assert.deepEqual(killed.writes, []);
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1);
  });
});

test("an approval of a change a revert cannot undo is left to the person, and nothing marks it ready", async () => {
  await lifecycle(async (tx) => {
    const patch = "diff --git a/prisma/schema.prisma b/prisma/schema.prisma\n@@ -1 +1 @@\n-a\n+b\n";
    const card = await reviewDraft(tx, patch);
    assert.deepEqual(await approve(card, ON), { applied: false, outcome: "handed_off" });
    const [row] = await tx.$queryRaw<Array<{ state: string; handoffReason: string | null; approvedHeadSha: string | null }>>`
      SELECT "state", "handoffReason", "approvedHeadSha" FROM "AmuxDmOwnerSettlement" WHERE "id" = ${card.settlementId}`;
    assert.deepEqual(row, { state: "open", handoffReason: "outside_dm_merge_allowlist", approvedHeadSha: null });
    const handed = await tx.adminAuditLog.findFirst({ where: { targetId: card.settlementId,
      action: "amux.dm_owner_settlement.handed_off" }, select: { metadata: true } });
    assert.deepEqual((handed?.metadata as { paths?: string[] }).paths, ["prisma/schema.prisma"]);
    const { runAmuxDmT2MergeReadyStep, readAmuxDmT2MergeLanePulls } = await services();
    const step = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, running: NONE, ports: step.ports, env: ON }),
      { outcome: "none" });
    assert.deepEqual(step.writes, []);
    assert.ok(!(await readAmuxDmT2MergeLanePulls(ON, { change: async () => ({ state: "open" as const,
      baseRef: "develop", headRef: card.ref, headSha: HEAD, diffDigest: DIFF, changedFiles: ["prisma/schema.prisma"],
      crossRepository: false }) }))
      .some((entry) => entry.number === card.prNumber));
  });
  // Switch off, the same approval is recorded exactly as before.
  await lifecycle(async (tx) => {
    const patch = "diff --git a/prisma/schema.prisma b/prisma/schema.prisma\n@@ -1 +1 @@\n-a\n+b\n";
    const card = await reviewDraft(tx, patch);
    assert.deepEqual(await approve(card, {}), { applied: true, outcome: "approved" });
    const { readAmuxDmT2MergeLanePulls } = await services();
    assert.deepEqual(await readAmuxDmT2MergeLanePulls({}), [], "off, the lane hears of nothing");
  });
});

test("CI admission's round marks the approved draft ready after its line, and only when the line leaves room", async () => {
  const { runCiAdmissionRound } = await import("@/lib/ciAdmissionRound");
  const { CI_ADMISSION_STATE_SETTING_KEY } = await import("@/lib/ciAdmissionCore");
  const before = process.env.TOMVERSE_AMUX_DM_T2_MERGE;
  process.env.TOMVERSE_AMUX_DM_T2_MERGE = "enabled";
  try {
    await lifecycle(async (tx) => {
      const card = await reviewDraft(tx, ORDINARY);
      assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
      await tx.appSetting.deleteMany({ where: { key: CI_ADMISSION_STATE_SETTING_KEY } });
      const agentDraft = { number: card.prNumber, nodeId: "PR_agent", title: "agent", base: "develop", head: card.ref,
        headSha: HEAD, draft: true, fork: false, labels: [] };
      const lineDraft = { number: 1, nodeId: "PR_line", title: "line", base: "develop", head: "claude/to-develop/x",
        headSha: "1".repeat(40), draft: true, fork: false, labels: [] };
      const fake = (pulls: typeof agentDraft[], deploys: { branch: string; sha: string; title: string }[]) => {
        const readied: number[] = [];
        const github = {
          openPulls: async () => pulls,
          runningPulls: async () => ({ keys: new Set<string>(), bases: new Map<number, string>(), deploys }),
          pull: async (number: number) => {
            const pull = pulls.find((entry) => entry.number === number);
            return pull ? { pull, open: true } : null;
          },
          check: async () => ({ conflict: false, behind: false }),
          convertToDraft: async () => {},
          markReady: async (pull: { number: number }) => { readied.push(pull.number); },
          personReady: async () => new Set<number>(), updateBranch: async () => {}, cancelRuns: async () => 0,
          runnerUsage: async () => [], setStatus: async () => {}, readRepo: async () => ({}),
        };
        const dmT2MergePorts = { pull: github.pull, markReady: github.markReady,
          change: async () => ({ state: "open" as const, baseRef: "develop", headRef: card.ref, headSha: HEAD,
            diffDigest: DIFF, changedFiles: ["components/Ordinary.tsx"], crossRepository: false }) };
        return { github, dmT2MergePorts, readied };
      };

      // A line draft takes the room first (develop push CI holds 18 of 40): the approved draft waits.
      const busy = fake([agentDraft, lineDraft], [{ branch: "develop", sha: "2".repeat(40), title: "push" }]);
      const first = await runCiAdmissionRound({ mode: "on", github: busy.github as never, now: () => Date.now(),
        dmT2MergePorts: busy.dmT2MergePorts });
      assert.equal(first.outcome, "done");
      assert.deepEqual(busy.readied, [lineDraft.number], "the line goes first; nothing jumps it");
      assert.equal((await readyAudits(tx, card.settlementId)).length, 0);

      // An empty line: the approved draft is marked ready once, after the line, with its event and audit.
      const free = fake([agentDraft], []);
      const second = await runCiAdmissionRound({ mode: "on", github: free.github as never, now: () => Date.now(),
        dmT2MergePorts: free.dmT2MergePorts });
      assert.equal(second.outcome, "done");
      assert.deepEqual(free.readied, [card.prNumber]);
      assert.equal((await readyAudits(tx, card.settlementId)).length, 1);
      const stored = await tx.appSetting.findUniqueOrThrow({ where: { key: CI_ADMISSION_STATE_SETTING_KEY } });
      const events = (JSON.parse(stored.value) as { events: Array<{ kind: string; number: number; detail: string | null }> }).events;
      assert.ok(events.some((entry) => entry.kind === "released" && entry.number === card.prNumber && entry.detail === "dm_approved"));
      const queue = (JSON.parse(stored.value) as { queue: Array<{ number: number }> }).queue;
      assert.ok(!queue.some((entry) => entry.number === card.prNumber), "it never joins the line");
      assert.equal(JSON.parse(stored.value).released.some((entry: { number: number }) => entry.number === card.prNumber),
        false, "nothing is reserved: a Decision Maker ready is a person's");

      // The next round, its CI not on GitHub yet: no second ready.
      const next = fake([agentDraft], []);
      await runCiAdmissionRound({ mode: "on", github: next.github as never, now: () => Date.now(),
        dmT2MergePorts: next.dmT2MergePorts });
      assert.deepEqual(next.readied, [], "held until its CI shows or ten minutes pass");

      // A fork's pull request is never taken, whatever it holds.
      const forked = fake([{ ...agentDraft, fork: true }], []);
      await runCiAdmissionRound({ mode: "on", github: forked.github as never, now: () => Date.now() + 11 * 60 * 1000,
        dmT2MergePorts: forked.dmT2MergePorts });
      assert.deepEqual(forked.readied, []);

      // Shadow mode writes nothing on GitHub.
      const shadow = fake([agentDraft], []);
      await runCiAdmissionRound({ mode: "shadow", github: shadow.github as never, now: () => Date.now(),
        dmT2MergePorts: shadow.dmT2MergePorts });
      assert.deepEqual(shadow.readied, []);
    });
  } finally {
    if (before === undefined) delete process.env.TOMVERSE_AMUX_DM_T2_MERGE;
    else process.env.TOMVERSE_AMUX_DM_T2_MERGE = before;
  }
});

test("the merge lane's list and the observer's read follow the approval while it still holds", async () => {
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    const { readAmuxDmT2MergeLanePulls, readAmuxDmT2MergeEvidence } = await services();
    // The lane's list reads the pull request's change from GitHub every time (review r-20261113-134019-5d8f82).
    const reads: number[] = [];
    const gh = (over: Record<string, unknown> | "throw" = {}) => ({ change: async (prNumber: number) => {
      reads.push(prNumber);
      if (over === "throw") throw new Error("http_error");
      return { state: "open" as const, baseRef: "develop", headRef: card.ref, headSha: HEAD, diffDigest: DIFF,
        changedFiles: ["components/Ordinary.tsx"], crossRepository: false, ...over };
    } });
    const mine = async (deps = gh()) => (await readAmuxDmT2MergeLanePulls(ON, deps))
      .filter((entry) => entry.number === card.prNumber);
    assert.deepEqual(await mine(), [], "nothing before the approval");
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    const visitedAt = async () => (await tx.$queryRaw<Array<{ at: Date }>>`
      SELECT "updatedAt" AS "at" FROM "AmuxDmOwnerSettlement" WHERE "id" = ${card.settlementId}`)[0]!.at.getTime();
    const before = await visitedAt();
    assert.deepEqual(await mine(), [{ number: card.prNumber, headSha: HEAD, headRef: card.ref }], "the same diff: listed");
    assert.ok(reads.includes(card.prNumber));
    // Its visit is recorded in the read's own bounded transaction, so the next read starts after it.
    assert.ok(await visitedAt() > before, "the lane's read records its visit");
    assert.deepEqual(await mine(gh({ diffDigest: "e".repeat(64) })), [],
      "a diff that moved with develop, or a person's ready pull request that changed: not listed");
    assert.deepEqual(await mine(gh({ diffDigest: null })), [], "a diff that cannot be read: not listed");
    assert.deepEqual(await mine(gh("throw")), [], "a read that fails: not listed");
    assert.deepEqual(await mine(gh({ changedFiles: ["components/Ordinary.tsx", "lib/providerCostBudget.ts"] })), [],
      "a file outside the allow list: not listed");
    assert.deepEqual(await mine(gh({ headSha: "a".repeat(40) })), [], "another head: not listed");
    assert.deepEqual(await mine(gh({ crossRepository: true })), [], "a fork's pull request: not listed");

    const merge = "e".repeat(40);
    const facts = await readAmuxDmT2MergeEvidence({ bindingId: card.bindingId, prNumber: card.prNumber, headSha: HEAD,
      mergeCommitSha: merge });
    assert.equal(facts?.settlementId, card.settlementId);
    assert.equal(facts?.approvedHeadSha, HEAD);
    assert.equal(facts?.approvedDiffDigest, DIFF);
    assert.equal(facts?.laneMerge, null, "the lane never merged it");
    // The evidence of a merge reads no switch: the same facts with the develop merge switch off.
    assert.deepEqual(await readAmuxDmT2MergeEvidence({ bindingId: card.bindingId, prNumber: card.prNumber, headSha: HEAD,
      mergeCommitSha: merge }), facts);

    // A Task that moved is not the lane's any more.
    await tx.amuxWorkItem.update({ where: { id: card.taskId }, data: { status: "blocked", revision: { increment: 1 } } });
    assert.deepEqual(await mine(), []);
  });
});

test("the lane's consume lets an engineering pull request merge only while its Decision Maker approval holds, read again then", async () => {
  // Review r-20261114-020758-a98fec: the lane's list was read a while before
  // the merge; the consume right before it judges the approval again in its
  // own transaction, and refuses when anything changed since.
  const { consumeQaReleaseMergeInstruction } = await import("@/lib/qaReleaseMergeLaneStore");
  const { amuxDmT2MergeConsumeAllowed, recordDecisionMakerSwitchByOperator } = await services();
  const OTHER_HEAD = "a".repeat(40);

  /** The lane's issued instruction for this pull request, placed as issue leaves it. */
  const issued = async (tx: LifecycleTx, card: Card, headSha = HEAD) => {
    const [{ next }] = await tx.$queryRaw<Array<{ next: number }>>`
      SELECT (coalesce(max("revision"), 0) + 1)::int AS "next" FROM "QaReleaseOperatorControl"`;
    const attemptId = randomUUID();
    await withoutTriggers(tx, async () => {
      await tx.$executeRaw`INSERT INTO "QaReleaseOperatorControl"
        ("revision", "digestEnabled", "mergeLaneEnabled", "developLaneOn", "auditLogId")
        VALUES (${next}, false, true, true, ${randomUUID()})`;
      await tx.$executeRaw`INSERT INTO "QaReleaseMergeAttempt"
        ("id", "pullRequestNumber", "headSha", "base", "controlRevision", "state", "lastAuditLogId", "issuedAt", "expiresAt")
        VALUES (${attemptId}, ${card.prNumber}, ${headSha}, 'develop', ${next}, 'issued', ${randomUUID()},
          now(), now() + interval '5 minutes')`;
    });
    return { attemptId, revision: next };
  };
  const consume = (card: Card, attempt: { attemptId: string; revision: number }, env: Record<string, string | undefined>,
    headSha = HEAD, diffDigest: string | null = DIFF) => consumeQaReleaseMergeInstruction({ callerRevision: attempt.revision, env,
    request: { attemptId: attempt.attemptId, pullRequestNumber: card.prNumber, headSha, base: "develop",
      ...(diffDigest !== null ? { diffDigest } : {}) },
    budget: { startedAt: Date.now(), budgetMs: 50_000, clock: Date.now } });
  const stateOf = async (tx: LifecycleTx, attemptId: string) => (await tx.$queryRaw<Array<{ state: string }>>`
    SELECT "state" FROM "QaReleaseMergeAttempt" WHERE "id" = ${attemptId}`)[0]!.state;
  const REFUSED = { consumed: false, reason: "dm_approval_not_holding" };

  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    // Not an engineering pull request: the lane's own rules decide it.
    assert.equal(await amuxDmT2MergeConsumeAllowed(tx, { prNumber: 7, headSha: HEAD, base: "develop", diffDigest: null, env: ON }),
      "not_engineering");
    assert.equal(await amuxDmT2MergeConsumeAllowed(tx, { prNumber: card.prNumber, headSha: HEAD, base: "develop",
      diffDigest: DIFF, env: ON }), "allowed");
    const attempt = await issued(tx, card);

    // Review r-20261114-021949-8dbd49: the diff as the lane read it right before -- another, or none -- is refused.
    assert.deepEqual(await consume(card, attempt, ON, HEAD, "e".repeat(64)), { consumed: false, reason: "dm_diff_changed" });
    assert.deepEqual(await consume(card, attempt, ON, HEAD, null), { consumed: false, reason: "dm_diff_changed" },
      "the lane read no diff");

    // The develop merge switch off since the list was read.
    assert.deepEqual(await consume(card, attempt, {}), REFUSED);
    // The kill switch on since.
    await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "on" });
    assert.deepEqual(await consume(card, attempt, ON), REFUSED);
    await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "off" });
    assert.equal(await stateOf(tx, attempt.attemptId), "issued", "a refusal writes nothing");
  });
  // A new head since: the instruction and the merge are for a head the Decision Maker never approved.
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    const attempt = await issued(tx, card, OTHER_HEAD);
    assert.deepEqual(await consume(card, attempt, ON, OTHER_HEAD), REFUSED);
    assert.equal(await stateOf(tx, attempt.attemptId), "issued");
  });
  // The Task moved since.
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    const attempt = await issued(tx, card);
    await tx.amuxWorkItem.update({ where: { id: card.taskId }, data: { status: "blocked", revision: { increment: 1 } } });
    assert.deepEqual(await consume(card, attempt, ON), REFUSED);
  });
  // The binding was superseded since.
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    const attempt = await issued(tx, card);
    await withoutTriggers(tx, () => tx.$executeRaw`
      UPDATE "EngineeringAgentBinding" SET "supersededAt" = now(), "currentPrNumber" = NULL
      WHERE "id" = ${card.bindingId}`);
    assert.deepEqual(await consume(card, attempt, ON), REFUSED);
  });
  // Still as approved: the judgment lets it through. (The consume's own write
  // needs its audit under the top transaction's id, which no savepoint of this
  // harness has; tests/integration/qa-release-merge-lane-store.db.test.ts runs
  // that write against a committing database.)
  await lifecycle(async (tx) => {
    const card = await reviewDraft(tx, ORDINARY);
    assert.deepEqual(await approve(card, ON), { applied: true, outcome: "approved" });
    await issued(tx, card);
    assert.equal(await amuxDmT2MergeConsumeAllowed(tx, { prNumber: card.prNumber, headSha: HEAD, base: "develop",
      diffDigest: DIFF, env: ON }), "allowed");
    assert.equal(await amuxDmT2MergeConsumeAllowed(tx, { prNumber: card.prNumber, headSha: HEAD, base: "main",
      diffDigest: DIFF, env: ON }), "dm_approval_not_holding", "never into main");
  });
});
