import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  CI_ADMISSION_MAX_CAPACITY,
  CI_ADMISSION_STATE_SETTING_KEY,
  ciAdmissionUnits,
  moveCiAdmissionEntry,
  reorderCiAdmissionQueue,
  type CiAdmissionMode,
  type CiAdmissionState,
} from "@/lib/ciAdmissionCore";
import { readCiFixView } from "@/lib/ciAdmissionFix";
import { CI_FIX_AGAIN_LABEL, ciFixRetryable, type CiFixView } from "@/lib/ciAdmissionFixCore";
import { ciAdmissionGithubConfig, createCiAdmissionGithub } from "@/lib/ciAdmissionGithub";
import { ciAdmissionMode, readState, serially, takeLock, writeState } from "@/lib/ciAdmissionRound";
import { prisma } from "@/lib/prisma";

/**
 * CI admission's Admin side: the view and the operator's changes, audited.
 * The round itself is lib/ciAdmissionRound.ts; changes run in the same
 * in-process sequence as rounds, so a round's corrections never undo one.
 */

export {
  ciAdmissionMode,
  requestCiAdmissionRound,
  runCiAdmissionRound,
  type CiAdmissionRoundOutcome,
} from "@/lib/ciAdmissionRound";

/* ------------------------------------------------------------------------- */
/* Admin                                                                      */
/* ------------------------------------------------------------------------- */

type AdminActor = { session: Session; request: Request };

export type CiAdmissionAdminView = {
  mode: CiAdmissionMode;
  configured: boolean;
  state: CiAdmissionState;
  /** The CI auto-fix on the review server, as it last reported (lib/ciAdmissionFixCore.ts). */
  fix: CiFixView;
};

export async function readCiAdmissionAdminView(): Promise<CiAdmissionAdminView> {
  const [state, fix] = await Promise.all([readState(prisma), readCiFixView(prisma)]);
  return { mode: ciAdmissionMode(), configured: ciAdmissionGithubConfig() !== null, state, fix };
}

export type CiAdmissionAdminChange =
  | { action: "reorder"; order: number[] }
  | { action: "move_top"; number: number }
  | { action: "move_bottom"; number: number }
  | { action: "set_capacity"; capacity: number };

/** Applies an operator's change under the admission lock and audits it; null when it no longer applies. */
export async function changeCiAdmission(actor: AdminActor, change: CiAdmissionAdminChange): Promise<CiAdmissionState | null> {
  // In turn with the rounds: never between a round's judgment and its
  // corrections, so a correction cannot undo an operator's change.
  return serially(() => applyCiAdmissionChange(actor, change));
}

async function applyCiAdmissionChange(actor: AdminActor, change: CiAdmissionAdminChange): Promise<CiAdmissionState | null> {
  return prisma.$transaction(async (tx) => {
    await takeLock(tx);
    await takeAuditChainLock(tx);
    const before = await readState(tx);
    let after: CiAdmissionState | null;
    let summary: string;
    if (change.action === "reorder") {
      after = reorderCiAdmissionQueue(before, change.order);
      summary = `Reordered the CI admission line: ${change.order.map((n) => `#${n}`).join(", ")}.`;
    } else if (change.action === "move_top" || change.action === "move_bottom") {
      const to = change.action === "move_top" ? "top" : "bottom";
      after = moveCiAdmissionEntry(before, change.number, to);
      summary = `Moved #${change.number} to the ${to} of the CI admission line.`;
    } else {
      after =
        Number.isInteger(change.capacity) && change.capacity >= 1 && change.capacity <= CI_ADMISSION_MAX_CAPACITY
          ? { ...before, capacity: change.capacity }
          : null;
      summary = `Set the CI admission budget to ${change.capacity} slots.`;
    }
    if (after === null) return null;
    await writeState(tx, after);
    await writeAdminAuditLog({
      ...actor,
      tx,
      action: "ci.admission.updated",
      targetType: "AppSettings",
      targetId: CI_ADMISSION_STATE_SETTING_KEY,
      summary,
      metadata: {
        change: change.action,
        before: { capacity: before.capacity, queue: before.queue.map((entry) => entry.number) },
        after: { capacity: after.capacity, queue: after.queue.map((entry) => entry.number) },
      },
    });
    return after;
  });
}

/* ------------------------------------------------------------------------- */
/* Operator stop                                                              */
/* ------------------------------------------------------------------------- */

export type CiAdmissionStopOutcome =
  | { outcome: "stopped"; drafted: boolean; cancelled: number; failure: string | null }
  | { outcome: "not_configured" | "not_found" | "not_handled" }
  | { outcome: "failed"; failure: string };

const failureCode = (error: unknown) => (error instanceof Error ? error.message.slice(0, 80) : "unknown");

/**
 * The operator's stop for one pull request using runners it should not: back
 * to draft (when open and ready) and every queued or running pull_request run
 * of it force-cancelled, in any mode admission is configured for. It moves to
 * the bottom of the line, so a free slot does not mark it ready again at once;
 * the operator moves it up when it should run. Whatever happened on GitHub is
 * audited.
 */
export function stopCiAdmissionPull(actor: AdminActor, number: number): Promise<CiAdmissionStopOutcome> {
  return serially(() => stopPull(actor, number));
}

async function stopPull(actor: AdminActor, number: number): Promise<CiAdmissionStopOutcome> {
  const config = ciAdmissionGithubConfig();
  if (!config) return { outcome: "not_configured" };
  const github = createCiAdmissionGithub(config);
  let found: Awaited<ReturnType<typeof github.pull>>;
  try {
    found = await github.pull(number);
  } catch (error) {
    return { outcome: "failed", failure: failureCode(error) };
  }
  if (!found) return { outcome: "not_found" };
  const { pull, open } = found;
  if (ciAdmissionUnits(pull) === null) return { outcome: "not_handled" };

  // Each step on its own: runs are cancelled even when the draft conversion
  // failed, and a draft made is recorded even when a cancellation failed.
  let drafted = false;
  let cancelled = 0;
  const failures: string[] = [];
  if (open && !pull.draft) {
    try {
      await github.convertToDraft(pull);
      drafted = true;
    } catch (error) {
      failures.push(`draft:${failureCode(error)}`);
    }
  }
  try {
    cancelled = await github.cancelRuns(pull, { force: true });
  } catch (error) {
    failures.push(`cancel:${failureCode(error)}`);
  }
  const failure = failures.length > 0 ? failures.join(" ").slice(0, 100) : null;
  if (!drafted && cancelled === 0 && failure) return { outcome: "failed", failure };

  await prisma.$transaction(async (tx) => {
    await takeLock(tx);
    await takeAuditChainLock(tx);
    const before = await readState(tx);
    // No reservation left, and to the bottom of the line: a free slot would
    // otherwise mark it ready again in the next round.
    const moved = moveCiAdmissionEntry(before, number, "bottom") ?? before;
    await writeState(tx, {
      ...moved,
      released: moved.released.filter((entry) => entry.number !== number),
      events: [
        ...before.events,
        {
          at: new Date().toISOString(),
          kind: "stopped" as const,
          number,
          shadow: false,
          detail: `${drafted ? "drafted " : ""}cancelled_runs:${cancelled}${failure ? ` ${failure}` : ""}`.slice(0, 120),
        },
      ].slice(-50),
    });
    await writeAdminAuditLog({
      ...actor,
      tx,
      action: "ci.admission.stopped",
      targetType: "PullRequest",
      targetId: String(number),
      summary: `Stopped #${number}: ${drafted ? "converted to draft, " : ""}${cancelled} run(s) force-cancelled.`,
      metadata: { number, base: pull.base, head: pull.head, open, drafted, cancelled, failure },
    });
  });
  return { outcome: "stopped", drafted, cancelled, failure };
}

/* ------------------------------------------------------------------------- */
/* Auto-fix: analyse again                                                    */
/* ------------------------------------------------------------------------- */

export type CiFixAgainOutcome =
  | { outcome: "requested" }
  | { outcome: "not_configured" | "not_found" | "not_open" | "not_retryable" }
  | { outcome: "failed"; failure: string };

/**
 * The operator's "Analyse again": the review server's CI auto-fix tries the
 * pull request's current head once more. Only a head it tried and did not fix,
 * and has not retried, is asked for; the request is the CI_FIX_AGAIN_LABEL
 * label put on now (the server reads GitHub, never the app, and acts only on
 * a label put on after the head's try), audited here.
 */
export async function requestCiFixAgain(actor: AdminActor, number: number): Promise<CiFixAgainOutcome> {
  const config = ciAdmissionGithubConfig();
  if (!config) return { outcome: "not_configured" };
  const github = createCiAdmissionGithub(config);
  let found: Awaited<ReturnType<typeof github.pull>>;
  try {
    found = await github.pull(number);
  } catch (error) {
    return { outcome: "failed", failure: failureCode(error) };
  }
  if (!found) return { outcome: "not_found" };
  if (!found.open) return { outcome: "not_open" };
  const fix = (await readCiFixView(prisma)).byPull[number];
  if (!ciFixRetryable(fix, found.pull.headSha, Date.now())) return { outcome: "not_retryable" };
  if (!github.setLabel) return { outcome: "not_configured" };
  try {
    // Off, then on: the server acts only on a "labeled" event newer than the
    // head's try, and a label still on from before makes no new one.
    await github.setLabel(number, CI_FIX_AGAIN_LABEL, false);
    await github.setLabel(number, CI_FIX_AGAIN_LABEL, true);
  } catch (error) {
    return { outcome: "failed", failure: failureCode(error) };
  }
  await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await writeAdminAuditLog({
      ...actor,
      tx,
      action: "ci.admission.fix_again",
      targetType: "PullRequest",
      targetId: String(number),
      summary: `Asked the CI auto-fix to try #${number} again at ${found.pull.headSha.slice(0, 9)}.`,
      metadata: { number, headSha: found.pull.headSha, previous: fix ? { outcome: fix.outcome, reason: fix.reason } : null },
    });
  });
  return { outcome: "requested" };
}
