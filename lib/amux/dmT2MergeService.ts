import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import {
  AMUX_DM_T2_MERGE_HEAD, AMUX_DM_T2_MERGE_READY_SETTLE_MS, amuxDmT2MergeChangeVerdict, amuxDmT2MergeEnabled,
  amuxDmT2MergeReadyInFlight, amuxDmT2MergeReadyVerdict,
  type AmuxDmT2MergeChangeNow,
} from "@/lib/amux/dmT2MergeCore";
import {
  readAmuxDmT2MergeApprovals, readAmuxDmT2MergeIsEngineeringPull, readAmuxDmT2MergeObservedFacts,
} from "@/lib/amux/dmT2MergeRead";
import type { CiAdmissionPull } from "@/lib/ciAdmissionCore";
import type { CiAdmissionGithub } from "@/lib/ciAdmissionGithub";
import { readEngineeringAgentPullChange } from "@/lib/engineeringAgentGitHubRead";

/**
 * The Decision Maker's develop merge of a review pull request (owner decision
 * 2026-11-13, lib/amux/dmT2MergeCore.ts), behind TOMVERSE_AMUX_DM_T2_MERGE,
 * default off. Three parts, each reading the approval again (an applied
 * settlement is never undone when its Task moves):
 *
 * - the ready step: once per CI admission round, after the line, one approved
 *   review draft is read fresh from GitHub and marked ready with CI
 *   admission's App, audited through the chain writer first;
 * - the merge lane's list: the approvals the lane may merge into develop,
 *   handed to it with its state read (lib/qaReleaseMergeLaneRoutes.ts);
 * - the observer's read: whether a merge the approver list did not make was
 *   the lane's own merge of a Decision Maker approval
 *   (lib/engineeringAgentPrObserver.ts).
 *
 * Main and every deploy stay a person's. The Decision Maker's kill switch,
 * on or unreadable, stops the first two.
 */

export const AMUX_DM_T2_MERGE_READY_ACTION = "amux.dm_t2_merge.ready_requested";
type Env = Readonly<Record<string, string | undefined>>;

/**
 * Records that one approval was looked at, one statement. Both readers take
 * the least recently visited first (readAmuxDmT2MergeApprovals orders by
 * updatedAt, then id); the visit is written on the database clock and always
 * after every other approval's, so the visited one goes to the very back even
 * when two would share a millisecond. Nothing else on the row moves.
 */
async function recordAmuxDmT2MergeVisit(tx: Prisma.TransactionClient, settlementId: string) {
  await tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "updatedAt" = GREATEST(clock_timestamp() AT TIME ZONE 'UTC',
      (SELECT max(o."updatedAt") FROM "AmuxDmOwnerSettlement" o WHERE o."state" = 'applied')
        + interval '1 millisecond')
    WHERE "id" = ${settlementId} AND "state" = 'applied'`;
}

/**
 * The one judgment of a Decision Maker approval at every use of it -- the
 * ready step's pick and its audit, the merge lane's list, and the lane's
 * consume right before the merge (review r-20261114-020758-a98fec). It gates
 * what happens next, so it reads the switches; the evidence of a merge that
 * already happened is readAmuxDmT2MergeEvidence's, which does not. The
 * develop merge switch on, the Decision Maker's kill switch read and off, and
 * the approvals that still hold in the database (readAmuxDmT2MergeApprovals:
 * the settlement applied and approve, the binding open, current and at the
 * approved head and digest, the Task in review, not archived, its newest run
 * the settled one). Anything unread or off holds nothing. A kill switch that
 * cannot be read has aborted the caller's transaction: nothing after it runs.
 */
export async function readAmuxDmT2MergeHolding(tx: Prisma.TransactionClient, input: {
  env: Env; limit: number; settlementId?: string | null; prNumbers?: readonly number[] | null;
}) {
  if (!amuxDmT2MergeEnabled(input.env)) return [];
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { return []; }
  if (killSwitch !== false) return [];
  return readAmuxDmT2MergeApprovals(tx, { limit: input.limit, settlementId: input.settlementId,
    prNumbers: input.prNumbers });
}

/**
 * The merge lane's consume of an instruction, in its own transaction, right
 * before the merge: an engineering agent pull request is let through only
 * while its Decision Maker approval still holds (readAmuxDmT2MergeHolding) at
 * exactly the head the lane will merge, into develop, and only when the diff
 * digest the lane read from GitHub right before is the approved one (a merge
 * base that moved with develop changes it at the same head). Any other pull
 * request is `not_engineering`: the lane's own rules decide it. At most three
 * statements.
 */
export async function amuxDmT2MergeConsumeAllowed(tx: Prisma.TransactionClient, input: {
  prNumber: number; headSha: string; base: string; diffDigest: string | null; env?: Env;
}): Promise<"not_engineering" | "allowed" | "dm_approval_not_holding" | "dm_diff_changed"> {
  if (!(await readAmuxDmT2MergeIsEngineeringPull(tx, input.prNumber))) return "not_engineering";
  if (input.base !== "develop") return "dm_approval_not_holding";
  const [held] = await readAmuxDmT2MergeHolding(tx, { env: input.env ?? process.env, limit: 1,
    prNumbers: [input.prNumber] });
  if (held === undefined || held.approvedHeadSha !== input.headSha) return "dm_approval_not_holding";
  return input.diffDigest === held.approvedDiffDigest ? "allowed" : "dm_diff_changed";
}

/**
 * The pull request the merge lane may take this round although its branch is
 * the engineering agent's: one approval per state read (review
 * r-20261113-140634-2ede9b; the lane merges at most one pull request a round
 * anyway). The least recently visited approval that still holds in the
 * database is picked and recorded as visited in the same transaction, then
 * its change is read again from GitHub (review r-20261113-134019-5d8f82):
 * listed only while its diff digest is the approved one and every path is on
 * the allow list (amuxDmT2MergeChangeVerdict). A change that differs or cannot
 * be read is not listed and has had its turn, so N approvals are each looked
 * at once in N rounds and none holds up the rest. Empty while the switch is
 * off or the kill switch is not off.
 */
export async function readAmuxDmT2MergeLanePulls(env: Env = process.env, deps: {
  change?: (prNumber: number) => Promise<AmuxDmT2MergeChangeNow>;
} = {}) {
  if (!amuxDmT2MergeEnabled(env)) return [];
  const row = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeLaneRead, async (tx) => {
    const [next] = await readAmuxDmT2MergeHolding(tx, { env, limit: 1 });
    if (next) await recordAmuxDmT2MergeVisit(tx, next.settlementId);
    return next ?? null;
  });
  if (!row) return [];
  const change = deps.change ?? ((prNumber: number) => readEngineeringAgentPullChange(prNumber));
  const now = await change(row.prNumber).catch(() => null);
  if (now === null) return [];
  const held = amuxDmT2MergeChangeVerdict({ change: now, approved: { prNumber: row.prNumber,
    headRef: row.headRef, approvedHeadSha: row.approvedHeadSha, approvedDiffDigest: row.approvedDiffDigest } });
  return held.holds ? [{ number: row.prNumber, headSha: row.approvedHeadSha, headRef: row.headRef }] : [];
}

/**
 * The evidence of a merge that already happened, for the approval observer:
 * the Decision Maker's approval of this binding's pull request as recorded,
 * and what the merge lane's own attempts say of this merge commit
 * (readAmuxDmT2MergeObservedFacts). Unlike readAmuxDmT2MergeHolding it reads
 * no switch (review r-20261114-021949-8dbd49): the develop merge switch and
 * the kill switch stop new readies and consumes, never the record of a merge
 * the lane already made on an approval -- a switch turned off between the
 * lane's merge and the observer's round must not stop the agent over it.
 */
export async function readAmuxDmT2MergeEvidence(input: {
  bindingId: string; prNumber: number; headSha: string; mergeCommitSha: string;
}) {
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeObservedRead,
    (tx) => readAmuxDmT2MergeObservedFacts(tx, input));
}

export type AmuxDmT2MergeReadyPorts = {
  /** The pull request as CI admission's App reads it now; null when there is none. */
  pull: (prNumber: number) => Promise<{ pull: CiAdmissionPull; open: boolean } | null>;
  /** Its change as the engineering agent's read-only token reads it now. */
  change: (prNumber: number) => Promise<AmuxDmT2MergeChangeNow>;
  /** CI admission's App's write: draft to ready. */
  markReady: (pull: CiAdmissionPull) => Promise<void>;
};

export const amuxDmT2MergeReadyPorts = (github: Pick<CiAdmissionGithub, "pull" | "markReady">): AmuxDmT2MergeReadyPorts => ({
  pull: (prNumber) => github.pull(prNumber),
  change: (prNumber) => readEngineeringAgentPullChange(prNumber),
  markReady: (pull) => github.markReady(pull),
});

export type AmuxDmT2MergeReadyOutcome =
  /** in_flight: an earlier Decision Maker ready's CI has not shown yet (amuxDmT2MergeReadyInFlight). */
  | { outcome: "off" | "none" | "no_room" | "in_flight" }
  | { outcome: "held"; settlementId: string; prNumber: number }
  | { outcome: "skipped"; settlementId: string; prNumber: number; reason: string }
  | { outcome: "already_ready"; settlementId: string; prNumber: number }
  /** Marked ready at this head, as a person would. */
  | { outcome: "marked_ready"; settlementId: string; prNumber: number; headSha: string }
  /** The write's answer is unknown: nothing is retried now; a later round reads the pull request first. */
  | { outcome: "write_unknown"; settlementId: string; prNumber: number; headSha: string; code: string };

const failureCode = (error: unknown) => (error instanceof Error ? error.message : "unknown").slice(0, 80);

/**
 * One step, at most one pull request. `drafts` are the open pull requests CI
 * admission's round read, `running` the pull_request runs it saw; `room` is
 * whether its line leaves room now (amuxDmT2MergeRoomBesideLine). A Decision
 * Maker ready is a person's ready: nothing is reserved, and while an earlier
 * one's CI has not shown on GitHub (its audit within ten minutes, its head not
 * running) no next one is made, so what can overflow is one pull request's
 * CI (amuxDmT2MergeReadyInFlight). The approval read next is the least recently
 * visited one among the engineering drafts, and its visit is recorded first,
 * so one that cannot move goes to the back. It is read fresh from GitHub --
 * CI admission's App for its stage and head, the engineering read token for
 * its diff and files -- and judged (amuxDmT2MergeReadyVerdict). A fork's pull
 * request is never taken. Only a pull request still exactly as approved, with
 * every path on the allow list, is audited and then marked ready. A write
 * whose answer is unknown is never retried here: the next round reads the
 * pull request, and one already ready needs nothing.
 */
export async function runAmuxDmT2MergeReadyStep(input: {
  drafts: readonly Pick<CiAdmissionPull, "number" | "head" | "headSha" | "base" | "draft" | "fork">[];
  room: boolean;
  running: ReadonlySet<string>;
  ports: AmuxDmT2MergeReadyPorts;
  env?: Env;
  nowMs?: number;
}): Promise<AmuxDmT2MergeReadyOutcome> {
  const env = input.env ?? process.env;
  if (!amuxDmT2MergeEnabled(env)) return { outcome: "off" };
  const drafts = input.drafts.filter((pull) => pull.draft && !pull.fork && pull.base === "develop" &&
    AMUX_DM_T2_MERGE_HEAD.test(pull.head));
  if (drafts.length === 0) return { outcome: "none" };
  if (!input.room) return { outcome: "no_room" };

  const nowMs = input.nowMs ?? Date.now();
  const picked = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeReadyPick, async (tx) => {
    // The Decision Maker readies of the last ten minutes, from their chain audits (written before each write).
    const recent = await tx.adminAuditLog.findMany({
      where: { action: AMUX_DM_T2_MERGE_READY_ACTION, createdAt: { gte: new Date(nowMs - AMUX_DM_T2_MERGE_READY_SETTLE_MS) } },
      orderBy: { createdAt: "desc" }, take: 20, select: { createdAt: true, metadata: true } });
    const readies = recent.flatMap((entry) => {
      const metadata = entry.metadata as { prNumber?: unknown; headSha?: unknown } | null;
      return typeof metadata?.prNumber === "number" && typeof metadata.headSha === "string"
        ? [{ prNumber: metadata.prNumber, headSha: metadata.headSha, atMs: entry.createdAt.getTime() }] : [];
    });
    if (amuxDmT2MergeReadyInFlight({ readies, running: input.running, nowMs })) return { inFlight: true as const };
    const [next] = await readAmuxDmT2MergeHolding(tx, { env, limit: 1, prNumbers: drafts.map((pull) => pull.number) });
    if (!next) return null;
    await recordAmuxDmT2MergeVisit(tx, next.settlementId);
    return { row: next };
  });
  if (picked && "inFlight" in picked) return { outcome: "in_flight" };
  if (!picked) return { outcome: "none" };
  const { row } = picked;
  const at = { settlementId: row.settlementId, prNumber: row.prNumber };

  let now: Awaited<ReturnType<AmuxDmT2MergeReadyPorts["pull"]>>;
  let change: AmuxDmT2MergeChangeNow;
  try {
    now = await input.ports.pull(row.prNumber);
    change = await input.ports.change(row.prNumber);
  } catch (error) {
    return { outcome: "skipped", ...at, reason: `unreadable:${failureCode(error)}` };
  }
  const verdict = amuxDmT2MergeReadyVerdict({
    approved: { prNumber: row.prNumber, headRef: row.headRef, approvedHeadSha: row.approvedHeadSha,
      approvedDiffDigest: row.approvedDiffDigest },
    pull: now ? { open: now.open, draft: now.pull.draft, base: now.pull.base, head: now.pull.head,
      headSha: now.pull.headSha, fork: now.pull.fork } : null,
    change,
  });
  if (verdict.verdict === "already_ready") return { outcome: "already_ready", ...at };
  if (verdict.verdict === "skip") return { outcome: "skipped", ...at, reason: verdict.reason };

  const recorded = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeReadyRecord, async (tx) => {
    await takeAuditChainLock(tx);
    const [still] = await readAmuxDmT2MergeHolding(tx, { env, limit: 1, settlementId: row.settlementId });
    if (!still || still.prNumber !== row.prNumber || still.approvedHeadSha !== row.approvedHeadSha ||
        still.approvedDiffDigest !== row.approvedDiffDigest || still.headRef !== row.headRef) return false;
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR, action: AMUX_DM_T2_MERGE_READY_ACTION,
      targetType: "AmuxDmOwnerSettlement", targetId: row.settlementId,
      summary: "Marked a review pull request the Decision Maker approved ready for review: its CI runs, and the merge lane may merge it into develop. Main stays a person's.",
      metadata: { taskId: row.taskId, attemptId: row.attemptId, bindingId: row.bindingId,
        prNumber: row.prNumber, headSha: row.approvedHeadSha, diffDigest: row.approvedDiffDigest,
        base: "develop" } });
    return true;
  });
  if (!recorded) return { outcome: "held", ...at };
  try {
    await input.ports.markReady(now!.pull);
  } catch (error) {
    return { outcome: "write_unknown", ...at, headSha: row.approvedHeadSha, code: failureCode(error) };
  }
  return { outcome: "marked_ready", ...at, headSha: row.approvedHeadSha };
}
