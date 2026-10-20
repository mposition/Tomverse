import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  CI_ADMISSION_MAX_CAPACITY,
  CI_ADMISSION_STATE_SETTING_KEY,
  reorderCiAdmissionQueue,
  type CiAdmissionMode,
  type CiAdmissionState,
} from "@/lib/ciAdmissionCore";
import { ciAdmissionGithubConfig } from "@/lib/ciAdmissionGithub";
import { ciAdmissionMode, readState, serially, takeLock, writeState } from "@/lib/ciAdmissionRound";
import { prisma } from "@/lib/prisma";

/**
 * CI admission's Admin side: the view and the operator's changes, audited.
 * The round itself is lib/ciAdmissionRound.ts; changes run in the same
 * in-process sequence as rounds, so a round's corrections never undo one.
 */

export { ciAdmissionMode, runCiAdmissionRound, type CiAdmissionRoundOutcome } from "@/lib/ciAdmissionRound";

/* ------------------------------------------------------------------------- */
/* Admin                                                                      */
/* ------------------------------------------------------------------------- */

type AdminActor = { session: Session; request: Request };

export type CiAdmissionAdminView = {
  mode: CiAdmissionMode;
  configured: boolean;
  state: CiAdmissionState;
};

export async function readCiAdmissionAdminView(): Promise<CiAdmissionAdminView> {
  return { mode: ciAdmissionMode(), configured: ciAdmissionGithubConfig() !== null, state: await readState(prisma) };
}

export type CiAdmissionAdminChange =
  | { action: "reorder"; order: number[] }
  | { action: "move_top"; number: number }
  | { action: "remove"; number: number }
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
    } else if (change.action === "move_top") {
      const order = before.queue.map((entry) => entry.number);
      after = order.includes(change.number)
        ? reorderCiAdmissionQueue(before, [change.number, ...order.filter((n) => n !== change.number)])
        : null;
      summary = `Moved #${change.number} to the top of the CI admission line.`;
    } else if (change.action === "remove") {
      // Out of the line for good: not put back as an unconfirmed release, nor
      // judged again as a pending arrival.
      after = before.queue.some((entry) => entry.number === change.number)
        ? {
            ...before,
            queue: before.queue.filter((entry) => entry.number !== change.number),
            releasing: before.releasing.filter((entry) => entry.number !== change.number),
            pendingArrivals: before.pendingArrivals.filter((number) => number !== change.number),
            // Its "waiting in line" status is cleared by the next round (the
            // route runs one at once), and retried until it is written.
            statusRetry: [...new Set([...before.statusRetry, change.number])].slice(-100),
          }
        : null;
      summary = `Removed #${change.number} from the CI admission line; it stays a draft.`;
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
