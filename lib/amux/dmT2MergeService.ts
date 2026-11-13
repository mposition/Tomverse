import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerSwitches, readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import {
  AMUX_DM_T2_MERGE_HEAD, amuxDmT2MergeChangeVerdict, amuxDmT2MergeEnabled, amuxDmT2MergeReadyVerdict,
  type AmuxDmT2MergeChangeNow,
} from "@/lib/amux/dmT2MergeCore";
import { readAmuxDmT2MergeApprovals, readAmuxDmT2MergeObservedFacts } from "@/lib/amux/dmT2MergeRead";
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
/** Approvals the lane hears of per state read: each costs a few GitHub reads inside the lane's 50 s call. */
const LANE_LIST_LIMIT = 5;
/** The GitHub reads of the lane's list start within this much of the call, well inside its 50 s budget. */
const LANE_LIST_READ_BUDGET_MS = 15_000;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Records that approvals were looked at, one statement: both readers take the
 * least recently visited first (readAmuxDmT2MergeApprovals orders by
 * updatedAt), so a visited one goes to the back. Nothing else on the row moves.
 */
async function recordAmuxDmT2MergeVisits(tx: Prisma.TransactionClient, settlementIds: string[]) {
  await tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id" = ANY(${settlementIds}) AND "state" = 'applied'`;
}

/**
 * The pull requests the merge lane may take although their branch is the
 * engineering agent's: each at the one head and branch approved, its change
 * read again from GitHub now (review r-20261113-134019-5d8f82) -- diff digest
 * the approved one, every path on the allow list
 * (amuxDmT2MergeChangeVerdict). A pull request a person made ready, or whose
 * merge base moved with develop, is listed only while that still holds; one
 * that cannot be read is not listed. Empty while the switch is off or the
 * kill switch is not off. The GitHub reads run outside the transaction, at
 * most LANE_LIST_LIMIT of them, within the lane's state call.
 *
 * Every approval read is recorded as visited in the same transaction, as the
 * ready step records its pick (review r-20261113-135805-1535ac): the next
 * state read starts with the ones least recently looked at, so approvals that
 * stay unmergeable -- a changed diff, a failed check, a conflict -- never hide
 * the ones behind them for more than a few rounds.
 */
export async function readAmuxDmT2MergeLanePulls(env: Env = process.env, deps: {
  change?: (prNumber: number) => Promise<AmuxDmT2MergeChangeNow>;
} = {}) {
  if (!amuxDmT2MergeEnabled(env)) return [];
  const rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeLaneRead, async (tx) => {
    if ((await readDecisionMakerSwitches(tx)).killSwitch !== false) return [];
    const read = await readAmuxDmT2MergeApprovals(tx, { limit: LANE_LIST_LIMIT });
    if (read.length > 0) await recordAmuxDmT2MergeVisits(tx, read.map((row) => row.settlementId));
    return read;
  });
  const change = deps.change ?? ((prNumber: number) => readEngineeringAgentPullChange(prNumber));
  const listed: Array<{ number: number; headSha: string; headRef: string }> = [];
  // What is not read in time is not listed this round; the lane asks again in ten minutes.
  const stopAt = Date.now() + LANE_LIST_READ_BUDGET_MS;
  for (const row of rows) {
    if (Date.now() > stopAt) break;
    const now = await change(row.prNumber).catch(() => null);
    if (now === null) continue;
    const held = amuxDmT2MergeChangeVerdict({ change: now, approved: { prNumber: row.prNumber,
      headRef: row.headRef, approvedHeadSha: row.approvedHeadSha, approvedDiffDigest: row.approvedDiffDigest } });
    if (held.holds) listed.push({ number: row.prNumber, headSha: row.approvedHeadSha, headRef: row.headRef });
  }
  return listed;
}

/** The observer's read of a merged binding's pull request; null while the switch is off. */
export async function readAmuxDmT2MergeObserved(input: {
  bindingId: string; prNumber: number; headSha: string; mergeCommitSha: string;
}, env: Env = process.env) {
  if (!amuxDmT2MergeEnabled(env)) return null;
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
  | { outcome: "off" | "none" | "no_room" }
  | { outcome: "held"; settlementId: string; prNumber: number }
  | { outcome: "skipped"; settlementId: string; prNumber: number; reason: string }
  | { outcome: "already_ready" | "marked_ready"; settlementId: string; prNumber: number }
  /** The write's answer is unknown: nothing is retried now; a later round reads the pull request first. */
  | { outcome: "write_unknown"; settlementId: string; prNumber: number; code: string };

const failureCode = (error: unknown) => (error instanceof Error ? error.message : "unknown").slice(0, 80);

/**
 * One step, at most one pull request. `drafts` are the open pull requests CI
 * admission's round read; `room` is whether its line leaves room
 * (amuxDmT2MergeRoomBesideLine). The approval read next is the least recently
 * visited one among the engineering drafts, and its visit is recorded first,
 * so one that cannot move goes to the back. It is read fresh from GitHub --
 * CI admission's App for its stage and head, the engineering read token for
 * its diff and files -- and judged (amuxDmT2MergeReadyVerdict). Only a pull
 * request still exactly as approved, with no path a person merges, is
 * audited and then marked ready. A write whose answer is unknown is never
 * retried here: the next round reads the pull request, and one already ready
 * needs nothing.
 */
export async function runAmuxDmT2MergeReadyStep(input: {
  drafts: readonly Pick<CiAdmissionPull, "number" | "head" | "headSha" | "base" | "draft">[];
  room: boolean;
  ports: AmuxDmT2MergeReadyPorts;
  env?: Env;
}): Promise<AmuxDmT2MergeReadyOutcome> {
  if (!amuxDmT2MergeEnabled(input.env ?? process.env)) return { outcome: "off" };
  const drafts = input.drafts.filter((pull) => pull.draft && pull.base === "develop" &&
    AMUX_DM_T2_MERGE_HEAD.test(pull.head));
  if (drafts.length === 0) return { outcome: "none" };
  if (!input.room) return { outcome: "no_room" };

  const row = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeReadyPick, async (tx) => {
    const [next] = await readAmuxDmT2MergeApprovals(tx, { limit: 1, prNumbers: drafts.map((pull) => pull.number) });
    if (!next) return null;
    await recordAmuxDmT2MergeVisits(tx, [next.settlementId]);
    return next;
  });
  if (!row) return { outcome: "none" };
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
      headSha: now.pull.headSha } : null,
    change,
  });
  if (verdict.verdict === "already_ready") return { outcome: "already_ready", ...at };
  if (verdict.verdict === "skip") return { outcome: "skipped", ...at, reason: verdict.reason };

  const recorded = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.dmT2MergeReadyRecord, async (tx) => {
    await takeAuditChainLock(tx);
    let killSwitch: boolean | null;
    try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
    catch { killSwitch = null; }
    if (killSwitch !== false) return false;
    const [still] = await readAmuxDmT2MergeApprovals(tx, { limit: 1, settlementId: row.settlementId });
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
    return { outcome: "write_unknown", ...at, code: failureCode(error) };
  }
  return { outcome: "marked_ready", ...at };
}
