import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  CI_ADMISSION_MAX_CAPACITY,
  CI_ADMISSION_STATE_SETTING_KEY,
  evaluateCiAdmission,
  parseCiAdmissionMode,
  parseCiAdmissionState,
  reorderCiAdmissionQueue,
  type CiAdmissionEvent,
  type CiAdmissionMode,
  type CiAdmissionState,
} from "@/lib/ciAdmissionCore";
import { ciAdmissionGithubConfig, createCiAdmissionGithub, type CiAdmissionGithub } from "@/lib/ciAdmissionGithub";
import { prisma } from "@/lib/prisma";

/**
 * CI admission's round and its Admin changes (lib/ciAdmissionCore.ts). One
 * round at a time: every round and every Admin change takes the same
 * transaction-scoped advisory lock first (then, for an Admin change, the audit
 * chain lock), so a webhook burst is judged in turn against the state the
 * previous round wrote.
 *
 * In `on` mode the round carries out its actions; a failed action is recorded
 * and its effect on the state undone (a hold that did not happen leaves the
 * pull request out of the line; a release that did not happen keeps it at the
 * top). Nothing is retried blind: the next round re-reads GitHub first. In
 * `shadow` mode the round records what it would have done and keeps the state
 * it read, so the line never drifts from GitHub.
 */

const LOCK = "tomverse-ci-admission";
const ROUND_TIMEOUT_MS = 60_000;

export const ciAdmissionMode = (env: NodeJS.ProcessEnv = process.env): CiAdmissionMode =>
  parseCiAdmissionMode(env.CI_ADMISSION_MODE) ?? "off";

const readState = async (db: Pick<Prisma.TransactionClient, "appSetting">) =>
  parseCiAdmissionState(
    (await db.appSetting.findUnique({ where: { key: CI_ADMISSION_STATE_SETTING_KEY }, select: { value: true } }))?.value,
  );

const writeState = (tx: Prisma.TransactionClient, state: CiAdmissionState) =>
  tx.appSetting.upsert({
    where: { key: CI_ADMISSION_STATE_SETTING_KEY },
    create: { key: CI_ADMISSION_STATE_SETTING_KEY, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });

const takeLock = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;

const code = (error: unknown) => (error instanceof Error ? error.message : "unknown").slice(0, 80);

export type CiAdmissionRoundOutcome =
  | { outcome: "off" | "not_configured" }
  | { outcome: "read_failed"; failure: string }
  | { outcome: "done"; mode: "shadow" | "on"; held: number[]; released: number[]; cancelled: number[]; failures: string[] };

/**
 * One round. `arrival` is the pull request whose webhook event made it ready
 * for review, or null for any other trigger.
 */
export async function runCiAdmissionRound(
  arrival: number | null,
  deps: { mode?: CiAdmissionMode; github?: CiAdmissionGithub | null; now?: () => number } = {},
): Promise<CiAdmissionRoundOutcome> {
  const mode = deps.mode ?? ciAdmissionMode();
  if (mode === "off") return { outcome: "off" };
  const config = ciAdmissionGithubConfig();
  const github = deps.github ?? (config ? createCiAdmissionGithub(config) : null);
  if (!github) return { outcome: "not_configured" };
  const now = deps.now ?? Date.now;

  return prisma.$transaction(
    async (tx) => {
      await takeLock(tx);
      const state = await readState(tx);
      let openPulls;
      let runningShas;
      try {
        openPulls = await github.openPulls();
        runningShas = await github.runningShas();
      } catch (error) {
        return { outcome: "read_failed", failure: code(error) } as const;
      }
      const evaluation = evaluateCiAdmission({ state, openPulls, runningShas, arrival, nowMs: now(), shadow: mode === "shadow" });

      if (mode === "shadow") {
        await writeState(tx, { ...state, events: evaluation.state.events, lastRound: evaluation.state.lastRound });
        return {
          outcome: "done",
          mode,
          held: evaluation.actions.filter((a) => a.kind === "hold").map((a) => a.pull.number),
          released: evaluation.actions.filter((a) => a.kind === "release").map((a) => a.pull.number),
          cancelled: evaluation.actions.filter((a) => a.kind === "cancel").map((a) => a.pull.number),
          failures: [],
        } as const;
      }

      const next = evaluation.state;
      const failures: string[] = [];
      const extra: CiAdmissionEvent[] = [];
      const at = new Date(now()).toISOString();
      const held: number[] = [];
      const released: number[] = [];
      const cancelled: number[] = [];
      for (const action of evaluation.actions) {
        const number = action.pull.number;
        // A hold has two steps; once the draft conversion succeeded the pull
        // request waits in line even if cancelling its runs then fails.
        let drafted = false;
        try {
          if (action.kind === "hold") {
            await github.convertToDraft(action.pull);
            drafted = true;
            held.push(number);
            const cancelled = await github.cancelRuns(action.pull);
            if (cancelled > 0) extra.push({ at, kind: "held", number, shadow: false, detail: `cancelled_runs:${cancelled}` });
          } else if (action.kind === "cancel") {
            await github.cancelRuns(action.pull);
            cancelled.push(number);
          } else {
            await github.markReady(action.pull);
            released.push(number);
          }
        } catch (error) {
          failures.push(`${action.kind}:${number}:${code(error)}`);
          extra.push({ at, kind: "failed", number, shadow: false, detail: `${action.kind}:${code(error)}`.slice(0, 120) });
          if (action.kind === "hold") {
            if (!drafted) next.queue = next.queue.filter((entry) => entry.number !== number);
          } else if (action.kind === "release") {
            next.released = next.released.filter((entry) => entry.number !== number);
            const entry = state.queue.find((queued) => queued.number === number);
            if (entry && !next.queue.some((queued) => queued.number === number)) next.queue.unshift(entry);
          }
        }
      }
      next.events = [...next.events, ...extra].slice(-50);
      await writeState(tx, next);
      return { outcome: "done", mode, held, released, cancelled, failures } as const;
    },
    { timeout: ROUND_TIMEOUT_MS, maxWait: ROUND_TIMEOUT_MS },
  );
}

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
      after = before.queue.some((entry) => entry.number === change.number)
        ? { ...before, queue: before.queue.filter((entry) => entry.number !== change.number) }
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
