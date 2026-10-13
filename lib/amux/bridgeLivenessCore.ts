/**
 * Whether the AMUX execution bridges on the Ubuntu host are still heartbeating,
 * judged from the worker runtime leases they keep alive.
 *
 * Each bridge registers one `AmuxWorkerRuntime` per session it runs and renews
 * every lease on each tick (`AMUX_WORKER_RUNTIME_LEASE_MS`, 90 s, at a ~31 s
 * cadence). When it halts -- exit 3, which systemd deliberately does not
 * restart (docs/ops/amux/wsl-execution-bridge.md, "halt와 재시작") -- or the
 * host or its network goes away, its leases run out and nothing renews them.
 * Between 2026-10-05 and 2026-10-10 that went unnoticed for 21 to 37 hours
 * at a time, four times. docs/ops/amux/bridge-monitoring.md is the runbook.
 *
 * **Each runtime is judged on its own.** The host runs several bridges, and the
 * first version of this judgement only reported when every lease had run out.
 * On 2026-10-13 `claude-impl` halted at 02:45Z, `claude-review` at 04:22Z, and
 * nothing was reported until the last bridge stopped at 05:32Z: one live lease
 * anywhere hid every halted bridge beside it.
 *
 * Only lease times and worker names are read. What a worker was doing and why
 * its bridge stopped stay out of this judgement and out of the alert: the cause
 * is read on the host, and the name says which unit to read.
 *
 * Pure: the infrastructure threshold monitor reads the rows and reports.
 */

/**
 * How long a lease may have been out before its runtime is reported lost.
 * A restart registers again within seconds, so this only absorbs a run that
 * lands in the moment between a lease running out and a fresh one.
 */
export const AMUX_BRIDGE_LOST_AFTER_MS = 5 * 60 * 1_000;

/**
 * A lease that ran out longer ago than this belongs to a runtime that is gone
 * for good -- moved, retired, or never coming back -- not to one that halted.
 * The reminders stop rather than repeat forever about a worker nobody runs.
 */
export const AMUX_BRIDGE_WATCH_HORIZON_MS = 48 * 60 * 60 * 1_000;

/** How often runtimes that stay lost are reported again. */
export const AMUX_BRIDGE_REMINDER_MS = 3 * 60 * 60 * 1_000;

/**
 * Worker runtimes that something other than a host bridge registers, and so
 * say nothing about whether the bridges are running.
 *
 * `engineering-runner` is registered by the app itself
 * (lib/engineeringAgentAmuxAdapter.ts, ENGINEERING_AGENT_AMUX_WORKER) for the
 * ninety seconds of each engineering agent run, every thirty minutes. Counted
 * as a bridge, its lease made a fleet that had halted at 13:01Z on 2026-10-12
 * read live three times overnight: three false recovery notices, each
 * followed by a fresh page. Judged on its own, it would be reported lost for
 * the other twenty-eight minutes of every half hour.
 * tests/amuxBridgeLivenessCore.test.mjs fails if any other code path starts
 * registering a runtime without being listed here.
 */
export const AMUX_NON_BRIDGE_WORKERS: readonly string[] = ["engineering-runner"];

export type AmuxBridgeLease = {
  readonly workerName: string;
  readonly leaseExpiresAt: Date;
};

export type AmuxLostRuntime = {
  /** The worker name, or `unnamed-runtime` when it is not a plain identifier. */
  readonly workerName: string;
  readonly leaseExpiresAt: Date;
};

export type AmuxBridgeLiveness =
  /** No lease inside the horizon: no bridge in this environment to watch. */
  | { readonly state: "unwatched" }
  /** Every watched runtime holds a live lease. */
  | { readonly state: "live"; readonly liveRuntimes: number }
  /** Some lease is out, none for `AMUX_BRIDGE_LOST_AFTER_MS` yet. */
  | { readonly state: "lapsing"; readonly lostSince: Date }
  | {
      readonly state: "lost";
      /** When the longest-lost runtime's lease ran out. */
      readonly lostSince: Date;
      /** Every runtime out for the grace period or longer, longest-lost first. */
      readonly lostRuntimes: readonly AmuxLostRuntime[];
      readonly liveRuntimes: number;
      readonly watchedRuntimes: number;
    };

/** The oldest lease expiry the judgement looks at. */
export const amuxBridgeWatchHorizonStart = (now: Date) =>
  new Date(now.getTime() - AMUX_BRIDGE_WATCH_HORIZON_MS);

/**
 * The name as it may appear in an alert. Worker names are registered through
 * an authenticated internal route, but the alert goes to Slack and email, so
 * anything that is not a plain identifier is replaced rather than quoted.
 */
const ALERTABLE_WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const alertableAmuxWorkerName = (workerName: string) =>
  ALERTABLE_WORKER_NAME.test(workerName) ? workerName : "unnamed-runtime";

export function judgeAmuxBridgeLiveness(
  leases: readonly AmuxBridgeLease[],
  now: Date
): AmuxBridgeLiveness {
  const horizon = amuxBridgeWatchHorizonStart(now).getTime();
  const watched = leases
    .filter((lease) => !AMUX_NON_BRIDGE_WORKERS.includes(lease.workerName))
    .map((lease) => ({
      workerName: lease.workerName,
      expiresAt: lease.leaseExpiresAt.getTime(),
    }))
    .filter(({ expiresAt }) => Number.isFinite(expiresAt) && expiresAt > horizon);
  if (watched.length === 0) return { state: "unwatched" };

  // A lease that runs out exactly now is out: the claim path reads it the same
  // way (lib/agentOfficeAmuxState.ts, lib/amux/workerRuntime.ts).
  const out = watched
    .filter(({ expiresAt }) => expiresAt <= now.getTime())
    .sort((a, b) => a.expiresAt - b.expiresAt);
  const liveRuntimes = watched.length - out.length;
  if (out.length === 0) return { state: "live", liveRuntimes };

  const lost = out.filter(
    ({ expiresAt }) => now.getTime() - expiresAt >= AMUX_BRIDGE_LOST_AFTER_MS
  );
  if (lost.length === 0) {
    return { state: "lapsing", lostSince: new Date(out[0].expiresAt) };
  }
  return {
    state: "lost",
    lostSince: new Date(lost[0].expiresAt),
    lostRuntimes: lost.map(({ workerName, expiresAt }) => ({
      workerName: alertableAmuxWorkerName(workerName),
      leaseExpiresAt: new Date(expiresAt),
    })),
    liveRuntimes,
    watchedRuntimes: watched.length,
  };
}

/**
 * The lost runtimes that were not lost at the previous check. A runtime that
 * joins the lost set pages at once, even inside the reminder cooldown that a
 * runtime lost earlier started: otherwise the second bridge to halt waits up
 * to three hours behind the first.
 */
export function newlyLostAmuxWorkers(
  previouslyLost: ReadonlySet<string>,
  verdict: AmuxBridgeLiveness
): string[] {
  if (verdict.state !== "lost") return [];
  return verdict.lostRuntimes
    .map((runtime) => runtime.workerName)
    .filter((workerName) => !previouslyLost.has(workerName));
}
