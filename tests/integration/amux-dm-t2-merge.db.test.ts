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
function github(card: Card, over: { draft?: boolean; headSha?: string; files?: string[]; markReady?: () => void } = {}) {
  const writes: number[] = [];
  return {
    writes,
    ports: {
      pull: async (prNumber: number) => prNumber !== card.prNumber ? null : ({ open: true, pull: {
        number: prNumber, nodeId: "PR_node", title: "t", base: "develop", head: card.ref,
        headSha: over.headSha ?? HEAD, draft: over.draft ?? true, fork: false, labels: [] } }),
      change: async () => ({ state: "open" as const, baseRef: "develop", headRef: card.ref,
        headSha: over.headSha ?? HEAD, diffDigest: DIFF, changedFiles: over.files ?? ["components/Ordinary.tsx"] }),
      markReady: async (pull: { number: number }) => { writes.push(pull.number); over.markReady?.(); },
    },
  };
}
const draftsOf = (card: Card) => [{ number: card.prNumber, head: card.ref, headSha: HEAD, base: "develop", draft: true }];

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
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: off.ports, env: {} }),
      { outcome: "off" });
    const full = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: false, ports: full.ports, env: ON }),
      { outcome: "no_room" });
    assert.deepEqual([...off.writes, ...full.writes], []);
    assert.equal((await readyAudits(tx, card.settlementId)).length, 0);

    const on = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: on.ports, env: ON }),
      { outcome: "marked_ready", settlementId: card.settlementId, prNumber: card.prNumber, headSha: HEAD });
    assert.deepEqual(on.writes, [card.prNumber]);
    const audits = await readyAudits(tx, card.settlementId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actorUserId, null, "the system, never a person");
    assert.ok(audits[0]!.entryHash, "through the hash-chained writer");
    assert.deepEqual((audits[0]!.metadata as Record<string, unknown>).headSha, HEAD);
    assert.deepEqual((audits[0]!.metadata as Record<string, unknown>).base, "develop");

    // Already ready: nothing more is written.
    const again = github(card, { draft: false });
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: again.ports, env: ON }),
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
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: lost.ports, env: ON }),
      { outcome: "write_unknown", settlementId: card.settlementId, prNumber: card.prNumber, headSha: HEAD,
        code: "github_graphql_502" });
    assert.deepEqual(lost.writes, [card.prNumber], "one call, never a second in the same step");
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1, "audited before the write");

    const cases: Array<[{ headSha?: string; files?: string[] }, string]> = [[{ headSha: "a".repeat(40) }, "head_moved"],
      [{ files: ["components/Ordinary.tsx", "lib/providerCostBudget.ts"] }, "outside_dm_merge_allowlist"]];
    for (const [over, reason] of cases) {
      const moved = github(card, over);
      const step = await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: moved.ports, env: ON });
      assert.equal(step.outcome, "skipped");
      assert.equal((step as { reason: string }).reason, reason);
      assert.deepEqual(moved.writes, []);
    }
    assert.equal((await readyAudits(tx, card.settlementId)).length, 1);

    await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "on" });
    const killed = github(card);
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: killed.ports, env: ON }),
      { outcome: "held", settlementId: card.settlementId, prNumber: card.prNumber });
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
    assert.deepEqual(await runAmuxDmT2MergeReadyStep({ drafts: draftsOf(card), room: true, ports: step.ports, env: ON }),
      { outcome: "none" });
    assert.deepEqual(step.writes, []);
    assert.ok(!(await readAmuxDmT2MergeLanePulls(ON, { change: async () => ({ state: "open" as const,
      baseRef: "develop", headRef: card.ref, headSha: HEAD, diffDigest: DIFF, changedFiles: ["prisma/schema.prisma"] }) }))
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
          convertToDraft: async () => {}, markReady: async (pull: { number: number }) => { readied.push(pull.number); },
          personReady: async () => new Set<number>(), updateBranch: async () => {}, cancelRuns: async () => 0,
          runnerUsage: async () => [], setStatus: async () => {}, readRepo: async () => ({}),
        };
        const dmT2MergePorts = { pull: github.pull, markReady: github.markReady,
          change: async () => ({ state: "open" as const, baseRef: "develop", headRef: card.ref, headSha: HEAD,
            diffDigest: DIFF, changedFiles: ["components/Ordinary.tsx"] }) };
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
      const releasedOf = async () => (JSON.parse((await tx.appSetting.findUniqueOrThrow({
        where: { key: CI_ADMISSION_STATE_SETTING_KEY } })).value) as { released: Array<{ number: number; headSha: string }> })
        .released.filter((entry) => entry.number === card.prNumber);
      assert.deepEqual((await releasedOf()).map((entry) => entry.headSha), [HEAD], "reserved like a release");

      // The next round, its runs not shown yet: its need is counted, so a line draft that would fit
      // beside the deploy alone (18 + 15) waits (18 + 15 + 15 > 40).
      const agentReady = { ...agentDraft, draft: false };
      const after = fake([agentReady, lineDraft], [{ branch: "develop", sha: "2".repeat(40), title: "push" }]);
      await runCiAdmissionRound({ mode: "on", github: after.github as never, now: () => Date.now(),
        dmT2MergePorts: after.dmT2MergePorts });
      assert.deepEqual(after.readied, [], "nothing is admitted into the runners it holds");
      assert.deepEqual((await releasedOf()).length, 1, "the reservation holds until its runs show");

      // A write whose answer is unknown is reserved as if it happened; GitHub still showing a draft drops it.
      await tx.appSetting.deleteMany({ where: { key: CI_ADMISSION_STATE_SETTING_KEY } });
      const lost = fake([agentDraft], []);
      lost.github.markReady = async () => { throw new Error("github_graphql_502"); };
      const unknown = await runCiAdmissionRound({ mode: "on", github: lost.github as never, now: () => Date.now(),
        dmT2MergePorts: { ...lost.dmT2MergePorts, markReady: lost.github.markReady } });
      assert.equal(unknown.outcome, "done");
      assert.ok((unknown as { failures: string[] }).failures.some((entry) => entry.startsWith(`dm_ready:${card.prNumber}:`)));
      assert.deepEqual((await releasedOf()).map((entry) => entry.headSha), [HEAD], "reserved although unknown");
      // GitHub shows it still a draft: the write never happened, its reservation is dropped, and the line
      // draft takes the room it held (18 + 15); the approved draft then finds no room and waits.
      const stillDraft = fake([agentDraft, lineDraft], [{ branch: "develop", sha: "2".repeat(40), title: "push" }]);
      await runCiAdmissionRound({ mode: "on", github: stillDraft.github as never, now: () => Date.now(),
        dmT2MergePorts: stillDraft.dmT2MergePorts });
      assert.deepEqual(stillDraft.readied, [lineDraft.number]);
      assert.deepEqual(await releasedOf(), []);

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
    const { readAmuxDmT2MergeLanePulls, readAmuxDmT2MergeObserved } = await services();
    // The lane's list reads the pull request's change from GitHub every time (review r-20261113-134019-5d8f82).
    const reads: number[] = [];
    const gh = (over: Record<string, unknown> | "throw" = {}) => ({ change: async (prNumber: number) => {
      reads.push(prNumber);
      if (over === "throw") throw new Error("http_error");
      return { state: "open" as const, baseRef: "develop", headRef: card.ref, headSha: HEAD, diffDigest: DIFF,
        changedFiles: ["components/Ordinary.tsx"], ...over };
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

    const merge = "e".repeat(40);
    const facts = await readAmuxDmT2MergeObserved({ bindingId: card.bindingId, prNumber: card.prNumber, headSha: HEAD,
      mergeCommitSha: merge }, ON);
    assert.equal(facts?.settlementId, card.settlementId);
    assert.equal(facts?.approvedHeadSha, HEAD);
    assert.equal(facts?.approvedDiffDigest, DIFF);
    assert.equal(facts?.laneMerge, null, "the lane never merged it");
    assert.equal(await readAmuxDmT2MergeObserved({ bindingId: card.bindingId, prNumber: card.prNumber, headSha: HEAD,
      mergeCommitSha: merge }, {}), null, "off, nothing is read");

    // A Task that moved is not the lane's any more.
    await tx.amuxWorkItem.update({ where: { id: card.taskId }, data: { status: "blocked", revision: { increment: 1 } } });
    assert.deepEqual(await mine(), []);
  });
});
