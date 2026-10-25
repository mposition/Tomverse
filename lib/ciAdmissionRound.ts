import type { Prisma } from "@prisma/client";

import {
  CI_ADMISSION_STATE_SETTING_KEY,
  ciAdmissionDraftsToCheck,
  evaluateCiAdmission,
  parseCiAdmissionMode,
  parseCiAdmissionState,
  type CiAdmissionAction,
  type CiAdmissionCheck,
  type CiAdmissionDeploy,
  type CiAdmissionEvent,
  type CiAdmissionMode,
  type CiAdmissionPull,
  type CiAdmissionState,
  type CiRunnerOwner,
} from "@/lib/ciAdmissionCore";
import { ciAdmissionGithubConfig, createCiAdmissionGithub, type CiAdmissionGithub } from "@/lib/ciAdmissionGithub";
import { createCoalescedRunner } from "@/lib/ciAdmissionWebhookCore";
import { prisma } from "@/lib/prisma";

/**
 * CI admission's round (lib/ciAdmissionCore.ts); the Admin changes are in
 * lib/ciAdmissionService.ts. No `server-only` and no audit writer here, so
 * instrumentation.ts can start the periodic sweep at boot.
 *
 * A round, in order, and one at a time in this process (the app runs one
 * replica; webhook deliveries ask for rounds, and a burst collapses into one):
 *
 *   1. read GitHub: the open pull requests, the running runs, and for the
 *      drafts at the top of the line whether they conflict with or lag their
 *      base;
 *   2. one short transaction under the admission lock: read the state (the
 *      order the operator set), judge the whole line, write it;
 *   3. outside any transaction, carry out the actions on GitHub;
 *   4. one more short transaction records what failed and which pending
 *      statuses were cleared.
 *
 * GitHub writes never run inside a database transaction. Nothing is undone or
 * retried blind: every round judges the whole line from GitHub as it is then,
 * so a write that failed is simply judged again.
 *
 * Sending a pull request back to draft sets its commit's `CI admission` status
 * to pending ("waiting in line; do not mark ready or re-run"), so a coding
 * session or CI monitor that reads the checks knows not to fight the line;
 * being marked ready again, a new head or closing sets it back to success.
 *
 * In `shadow` mode the round records the line and what it would have done,
 * and changes nothing on GitHub.
 */

const LOCK = "tomverse-ci-admission";
const TX_TIMEOUT_MS = 15_000;
/** Retry after a failed GitHub read or write. */
const RETRY_AFTER_FAILURE_MS = 60_000;

const STATUS = {
  waiting: "Waiting in the CI admission line; released automatically when a slot frees. Do not mark ready or re-run.",
  granted: "CI admission: slot granted, CI may run.",
} as const;

export const ciAdmissionMode = (env: NodeJS.ProcessEnv = process.env): CiAdmissionMode =>
  parseCiAdmissionMode(env.CI_ADMISSION_MODE) ?? "off";

/** Whether a draft behind its base has its branch updated: on unless CI_ADMISSION_UPDATE_BRANCH is "off". */
export const ciAdmissionUpdatesBranches = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.CI_ADMISSION_UPDATE_BRANCH ?? "").trim().toLowerCase() !== "off";

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
  // The latest round decides: none needed clears an earlier one.
  if (recheck) clearTimeout(recheck);
  recheck = null;
  if (inMs === null) return;
  recheck = setTimeout(() => {
    recheck = null;
    void runCiAdmissionRound().catch((error: unknown) => {
      console.error("CI admission recheck failed:", code(error));
    });
  }, inMs + 1_000);
  recheck.unref?.();
};

/**
 * A round wanted by a webhook delivery: started now when none runs, else one
 * more after the running one, however many deliveries ask meanwhile. GitHub
 * waits ten seconds for an answer, and a busy hour sends hundreds of
 * workflow_run deliveries; awaiting a round per delivery queued them past
 * that limit and dropped the pull_request deliveries among them.
 */
const requestRound = createCoalescedRunner(async () => {
  await runCiAdmissionRound().catch((error: unknown) => {
    console.error("CI admission round failed:", code(error));
  });
});
export const requestCiAdmissionRound = (): void => requestRound();

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

const numbersOf = (actions: CiAdmissionAction[], kind: "hold" | "release" | "cancel") =>
  actions.flatMap((action) => (action.kind === kind ? [action.pull.number] : []));

/** One round over the whole line; rounds run one at a time in this process. */
export function runCiAdmissionRound(deps: RoundDeps = {}): Promise<CiAdmissionRoundOutcome> {
  return serially(() => round(deps));
}

async function round(deps: RoundDeps): Promise<CiAdmissionRoundOutcome> {
  const mode = deps.mode ?? ciAdmissionMode();
  if (mode === "off") return { outcome: "off" };
  const config = ciAdmissionGithubConfig();
  const github = deps.github ?? (config ? createCiAdmissionGithub(config) : null);
  if (!github) return { outcome: "not_configured" };
  const now = deps.now ?? Date.now;

  // 1. GitHub, outside any transaction: the open pull requests, the runs, and
  // for the drafts at the top of the line whether they conflict or lag.
  let openPulls: CiAdmissionPull[];
  let running: Set<string>;
  let runningBases: Map<number, string>;
  let deploys: CiAdmissionDeploy[];
  const checks = new Map<number, CiAdmissionCheck>();
  let runners: CiRunnerOwner[] | null = null;
  try {
    openPulls = await github.openPulls();
    ({ keys: running, bases: runningBases, deploys } = await github.runningPulls());
    const toCheck = ciAdmissionDraftsToCheck({ state: await readState(prisma), openPulls, running, runningBases, deploys, nowMs: now() });
    for (const pull of toCheck) {
      checks.set(pull.number, await github.check(pull));
    }
    // Who holds runners now, per pull request; unread, every CI counts at its need.
    runners = await github.runnerUsage().catch(() => null);
  } catch (error) {
    scheduleRecheck(RETRY_AFTER_FAILURE_MS);
    return { outcome: "read_failed", failure: code(error) };
  }

  // 2. Judge and record, under the lock: the order an Admin change wrote
  // meanwhile is the one judged.
  const evaluation = await prisma.$transaction(
    async (tx) => {
      await takeLock(tx);
      const state = await readState(tx);
      const judged = evaluateCiAdmission({ state, openPulls, running, runningBases, deploys, checks, runners, nowMs: now(), shadow: mode === "shadow", updateBranches: ciAdmissionUpdatesBranches() });
      // Shadow keeps what it would have done out of the reservations and statuses.
      await writeState(
        tx,
        mode === "shadow"
          ? { ...judged.state, released: state.released, pendingStatus: state.pendingStatus, updating: state.updating }
          : judged.state,
      );
      return judged;
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
  );
  const summary = {
    held: numbersOf(evaluation.actions, "hold"),
    released: numbersOf(evaluation.actions, "release"),
    cancelled: numbersOf(evaluation.actions, "cancel"),
  };
  if (mode === "shadow") return { outcome: "done", mode, ...summary, failures: [], nextCheckInMs: evaluation.nextCheckInMs };

  // 3. Carry the actions out on GitHub, holds and cancellations first. Each
  // round judges from GitHub as it is then, so a failed write needs no undo:
  // the next round sees it and decides again.
  const failures: string[] = [];
  const at = new Date(now()).toISOString();
  const extra: CiAdmissionEvent[] = [];
  const cleared = new Set<string>();
  const failedReleases = new Set<number>();
  const first = (action: CiAdmissionAction) => action.kind === "hold" || action.kind === "cancel";
  for (const action of [...evaluation.actions.filter(first), ...evaluation.actions.filter((action) => !first(action))]) {
    const number = action.kind === "clear_status" ? action.number : action.pull.number;
    try {
      if (action.kind === "hold") {
        await github.convertToDraft(action.pull);
        const cancelled = await github.cancelRuns(action.pull);
        if (cancelled > 0) extra.push({ at, kind: "held", number, shadow: false, detail: `cancelled_runs:${cancelled}` });
        await github.setStatus(action.pull.headSha, "pending", STATUS.waiting);
      } else if (action.kind === "cancel") {
        await github.cancelRuns(action.pull);
      } else if (action.kind === "update_branch") {
        await github.updateBranch(action.pull);
      } else if (action.kind === "release") {
        await github.markReady(action.pull);
        await github.setStatus(action.pull.headSha, "success", STATUS.granted);
      } else {
        await github.setStatus(action.headSha, "success", STATUS.granted);
        cleared.add(`${action.number}@${action.headSha}`);
      }
    } catch (error) {
      failures.push(`${action.kind}:${number}:${code(error)}`);
      extra.push({ at, kind: "failed", number, shadow: false, detail: `${action.kind}:${code(error)}`.slice(0, 120) });
      if (action.kind === "release") failedReleases.add(number);
    }
  }

  // 4. What happened, on top of the state as it is now.
  if (extra.length > 0 || cleared.size > 0 || failedReleases.size > 0) {
    await prisma.$transaction(
      async (tx) => {
        await takeLock(tx);
        const current = await readState(tx);
        await writeState(tx, {
          ...current,
          pendingStatus: current.pendingStatus.filter((entry) => !cleared.has(`${entry.number}@${entry.headSha}`)),
          // A release that did not happen reserves nothing.
          released: current.released.filter((entry) => !failedReleases.has(entry.number)),
          events: [...current.events, ...extra].slice(-50),
        });
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS },
    );
  }
  scheduleRecheck(failures.length > 0 ? RETRY_AFTER_FAILURE_MS : evaluation.nextCheckInMs);
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
    void runCiAdmissionRound().catch((error: unknown) => {
      console.error("CI admission sweep failed:", code(error));
    });
  };
  setTimeout(tick, SWEEP_FIRST_MS).unref?.();
  setInterval(tick, SWEEP_EVERY_MS).unref?.();
}
