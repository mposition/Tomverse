import type { Prisma } from "@prisma/client";

import {
  CI_ADMISSION_STATE_SETTING_KEY,
  evaluateCiAdmission,
  parseCiAdmissionMode,
  parseCiAdmissionState,
  type CiAdmissionAction,
  type CiAdmissionEvent,
  type CiAdmissionMode,
  type CiAdmissionPull,
  type CiAdmissionQueueEntry,
  type CiAdmissionState,
} from "@/lib/ciAdmissionCore";
import { ciAdmissionGithubConfig, createCiAdmissionGithub, type CiAdmissionGithub } from "@/lib/ciAdmissionGithub";
import { prisma } from "@/lib/prisma";

/**
 * CI admission's round (lib/ciAdmissionCore.ts); the Admin changes are in
 * lib/ciAdmissionService.ts. No `server-only` and no audit writer here, so
 * instrumentation.ts can start the periodic sweep at boot.
 *
 * A round, in order, and one at a time in this process (the app runs one
 * replica; a webhook burst is judged in turn):
 *
 *   1. read GitHub (open pull requests, running pull_request runs);
 *   2. one short transaction under the admission lock: read the state, judge,
 *      write the judged state;
 *   3. outside any transaction, carry out the actions on GitHub;
 *   4. if any failed, one more short transaction under the lock applies the
 *      corrections on top of whatever the state is by then (an Admin reorder
 *      may have landed meanwhile).
 *
 * GitHub writes never run inside a database transaction, so a rollback can
 * never leave GitHub changed and the state unwritten. If the process dies
 * between 2 and 3 the state is ahead of GitHub and the next round heals it: a
 * pull request it meant to hold is still ready, so it leaves the line as
 * "ready elsewhere". A release whose ready call fails goes back to the top of
 * the line in step 4. Nothing is retried blind: the next round re-reads GitHub.
 *
 * Every hold also sets the `CI admission` commit status to pending ("waiting
 * in line; do not mark ready or re-run"), so a coding session or CI monitor
 * that reads the checks knows not to fight the line; release, admission and
 * leaving the line set it to success.
 *
 * In `shadow` mode the round records what it would have done and keeps the
 * state it read, so the line never drifts from GitHub.
 */

const LOCK = "tomverse-ci-admission";
const TX_TIMEOUT_MS = 15_000;
/** Retry after a failed GitHub read or a failed release. */
const RETRY_AFTER_FAILED_RELEASE_MS = 60_000;

const STATUS = {
  waiting: "Waiting in the CI admission line; released automatically when a slot frees. Do not mark ready or re-run.",
  granted: "CI admission: slot granted, CI may run.",
  left: "No longer waiting in the CI admission line.",
} as const;

export const ciAdmissionMode = (env: NodeJS.ProcessEnv = process.env): CiAdmissionMode =>
  parseCiAdmissionMode(env.CI_ADMISSION_MODE) ?? "off";

export const readState = async (db: Pick<Prisma.TransactionClient, "appSetting">) =>
  parseCiAdmissionState(
    (await db.appSetting.findUnique({ where: { key: CI_ADMISSION_STATE_SETTING_KEY }, select: { value: true } }))?.value,
  );

export const writeState = (tx: Prisma.TransactionClient, state: CiAdmissionState) =>
  tx.appSetting.upsert({
    where: { key: CI_ADMISSION_STATE_SETTING_KEY },
    create: { key: CI_ADMISSION_STATE_SETTING_KEY, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });

export const takeLock = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;

const code = (error: unknown) => (error instanceof Error ? error.message : "unknown").slice(0, 80);

// One round at a time in this process.
let roundChain: Promise<unknown> = Promise.resolve();
export const serially = <T>(work: () => Promise<T>): Promise<T> => {
  const next = roundChain.then(work, work);
  roundChain = next.catch(() => undefined);
  return next;
};

// When someone waits behind a reservation that GitHub has not yet shown runs
// for, judge again when it expires rather than wait for the next webhook. One
// timer per process; a restart loses it, and the next event does the same job.
let recheck: ReturnType<typeof setTimeout> | null = null;
const scheduleRecheck = (inMs: number | null) => {
  if (inMs === null) return;
  if (recheck) clearTimeout(recheck);
  recheck = setTimeout(() => {
    recheck = null;
    void runCiAdmissionRound(null).catch((error: unknown) => {
      console.error("CI admission recheck failed:", code(error));
    });
  }, inMs + 1_000);
  recheck.unref?.();
};

export type CiAdmissionRoundOutcome =
  | { outcome: "off" | "not_configured" }
  | { outcome: "read_failed"; failure: string }
  | {
      outcome: "done";
      mode: "shadow" | "on";
      held: number[];
      released: number[];
      cancelled: number[];
      failures: string[];
      nextCheckInMs: number | null;
    };

type RoundDeps = { mode?: CiAdmissionMode; github?: CiAdmissionGithub | null; now?: () => number };

const numbersOf = (actions: CiAdmissionAction[], kind: CiAdmissionAction["kind"]) =>
  actions.filter((a) => a.kind === kind).map((a) => a.pull.number);

/**
 * One round. `arrival` is the pull request whose webhook event made it ready
 * for review, or null for any other trigger.
 */
export function runCiAdmissionRound(arrival: number | null, deps: RoundDeps = {}): Promise<CiAdmissionRoundOutcome> {
  return serially(() => round(arrival, deps));
}

async function round(arrival: number | null, deps: RoundDeps): Promise<CiAdmissionRoundOutcome> {
  const mode = deps.mode ?? ciAdmissionMode();
  if (mode === "off") return { outcome: "off" };
  const config = ciAdmissionGithubConfig();
  const github = deps.github ?? (config ? createCiAdmissionGithub(config) : null);
  if (!github) return { outcome: "not_configured" };
  const now = deps.now ?? Date.now;

  // 1. GitHub, outside any transaction.
  let openPulls: CiAdmissionPull[];
  let running: Set<string>;
  try {
    openPulls = await github.openPulls();
    running = await github.runningPulls();
  } catch (error) {
    // Keep the arrival for the next round (it survives a restart), and try
    // again shortly: the event that brought this round may be the last for a while.
    if (arrival !== null) {
      await prisma.$transaction(
        async (tx) => {
          await takeLock(tx);
          const current = await readState(tx);
          if (!current.pendingArrivals.includes(arrival)) {
            await writeState(tx, { ...current, pendingArrivals: [...current.pendingArrivals, arrival].slice(-100) });
          }
        },
        { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
      );
    }
    scheduleRecheck(RETRY_AFTER_FAILED_RELEASE_MS);
    return { outcome: "read_failed", failure: code(error) };
  }

  // 2. Judge and record, under the lock.
  const { evaluation, owedStatuses } = await prisma.$transaction(
    async (tx) => {
      await takeLock(tx);
      const state = await readState(tx);
      const judged = evaluateCiAdmission({ state, openPulls, running, arrival, nowMs: now(), shadow: mode === "shadow" });
      await writeState(
        tx,
        mode === "shadow"
          ? { ...state, events: judged.state.events, lastRound: judged.state.lastRound, pendingArrivals: [] }
          : judged.state,
      );
      // Statuses owed from earlier rounds; this round's own are written by its actions.
      return { evaluation: judged, owedStatuses: state.statusRetry };
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
  );
  const summary = {
    held: numbersOf(evaluation.actions, "hold"),
    released: numbersOf(evaluation.actions, "release"),
    cancelled: numbersOf(evaluation.actions, "cancel"),
  };
  if (mode === "shadow") {
    return { outcome: "done", mode, ...summary, failures: [], nextCheckInMs: evaluation.nextCheckInMs };
  }

  // 3. Carry the actions out on GitHub.
  const failures: string[] = [];
  const at = new Date(now()).toISOString();
  const extra: CiAdmissionEvent[] = [];
  const undoHold = new Set<number>();
  const rejudge = new Set<number>();
  const putBack: CiAdmissionQueueEntry[] = [];
  const statusFailed = new Set<number>();
  const statusResolved = new Set<number>();
  const status = async (pull: CiAdmissionPull, state: "pending" | "success", text: string) => {
    try {
      await github.setStatus(pull, state, text);
      statusResolved.add(pull.number);
      statusFailed.delete(pull.number);
    } catch (error) {
      failures.push(`status:${pull.number}:${code(error)}`);
      statusFailed.add(pull.number);
    }
  };
  // Statuses an earlier round could not write, first: what each should say
  // now follows from the line (pending in it, success out of it), and this
  // round's own actions below then write anything newer.
  const open = new Map(openPulls.map((pull) => [pull.number, pull]));
  const inLine = new Set(evaluation.state.queue.map((entry) => entry.number));
  for (const number of owedStatuses) {
    const pull = open.get(number);
    if (!pull) {
      statusResolved.add(number);
      continue;
    }
    await status(pull, inLine.has(number) ? "pending" : "success", inLine.has(number) ? STATUS.waiting : STATUS.left);
  }
  // Holds and cancellations first: a release may count on the slots they
  // free. If any fails (a pull request stays ready, or runs keep running),
  // this round's releases wait -- back to the top -- and the next round
  // decides, still counting a draft's unstopped runs as occupied.
  let holdFailed = false;
  const first = (action: CiAdmissionAction) => action.kind === "hold" || action.kind === "cancel";
  const ordered = [...evaluation.actions.filter(first), ...evaluation.actions.filter((action) => !first(action))];
  for (const action of ordered) {
    const number = action.pull.number;
    let drafted = false;
    try {
      if (action.kind === "hold") {
        await github.convertToDraft(action.pull);
        drafted = true;
        await status(action.pull, "pending", STATUS.waiting);
        const cancelled = await github.cancelRuns(action.pull);
        if (cancelled > 0) extra.push({ at, kind: "held", number, shadow: false, detail: `cancelled_runs:${cancelled}` });
      } else if (action.kind === "release") {
        if (holdFailed) throw new Error("deferred_after_failed_hold");
        await github.markReady(action.pull);
        await status(action.pull, "success", STATUS.granted);
      } else if (action.kind === "cancel") {
        await github.cancelRuns(action.pull);
      } else if (action.kind === "admit") {
        await status(action.pull, "success", STATUS.granted);
      } else {
        await status(action.pull, "success", STATUS.left);
      }
    } catch (error) {
      failures.push(`${action.kind}:${number}:${code(error)}`);
      extra.push({ at, kind: "failed", number, shadow: false, detail: `${action.kind}:${code(error)}`.slice(0, 120) });
      if (action.kind === "hold" || action.kind === "cancel") holdFailed = true;
      if (action.kind === "hold" && !drafted) {
        // Still ready on GitHub: out of the line, and judged again next round.
        undoHold.add(number);
        rejudge.add(number);
      }
      if (action.kind === "release") putBack.push(action.entry);
    }
  }

  // 4. Corrections, on top of the state as it is now.
  const retryChanged = statusFailed.size > 0 || statusResolved.size > 0;
  if (extra.length > 0 || undoHold.size > 0 || putBack.length > 0 || rejudge.size > 0 || retryChanged) {
    await prisma.$transaction(
      async (tx) => {
        await takeLock(tx);
        const current = await readState(tx);
        const queue = current.queue.filter((entry) => !undoHold.has(entry.number));
        for (const entry of [...putBack].reverse()) {
          if (!queue.some((queued) => queued.number === entry.number)) queue.unshift(entry);
        }
        const failedReleases = new Set(putBack.map((entry) => entry.number));
        await writeState(tx, {
          ...current,
          pendingArrivals: [...new Set([...current.pendingArrivals, ...rejudge])].slice(-100),
          statusRetry: [...new Set([...current.statusRetry.filter((n) => !statusResolved.has(n)), ...statusFailed])].slice(-100),
          queue: queue.slice(0, 100),
          released: current.released.filter((entry) => !failedReleases.has(entry.number)),
          events: [...current.events, ...extra].slice(-50),
        });
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
    );
  }
  // A release that failed is back at the top: try again shortly, since the
  // failed call itself promises no further webhook.
  // Any failed GitHub write -- a release, a hold, a status, a cancellation --
  // is picked up again by the next round, which judges from GitHub as it is
  // then (a draft still running CI is cancelled again); make sure one comes.
  scheduleRecheck(failures.length > 0 ? RETRY_AFTER_FAILED_RELEASE_MS : evaluation.nextCheckInMs);
  return { outcome: "done", mode, ...summary, failures, nextCheckInMs: evaluation.nextCheckInMs };
}

/**
 * The periodic sweep: a round 30 s after the server starts and every 5
 * minutes after, whatever webhooks do or do not arrive. It is what resumes
 * work a stopped process left recorded but undone -- an unconfirmed release,
 * an owed status, a pending arrival -- since a restart loses the in-process
 * retry timer and GitHub sends no event for something that never happened.
 * Off mode makes each tick a no-op. Started once per process.
 */
const SWEEP_FIRST_MS = 30_000;
const SWEEP_EVERY_MS = 5 * 60_000;
const SWEEP_STARTED = Symbol.for("tomverse.ciAdmission.sweepStarted");

export function startCiAdmissionSweep(): void {
  const registry = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (registry[SWEEP_STARTED]) return;
  registry[SWEEP_STARTED] = true;
  const tick = () => {
    if (ciAdmissionMode() === "off") return;
    void runCiAdmissionRound(null).catch((error: unknown) => {
      console.error("CI admission sweep failed:", code(error));
    });
  };
  setTimeout(tick, SWEEP_FIRST_MS).unref?.();
  setInterval(tick, SWEEP_EVERY_MS).unref?.();
}
