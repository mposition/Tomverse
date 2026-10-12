/**
 * Whether the AMUX execution bridge on the Ubuntu host is still heartbeating,
 * judged from the worker runtime leases it keeps alive.
 *
 * The bridge registers one `AmuxWorkerRuntime` per session it runs and renews
 * every lease on each tick (`AMUX_WORKER_RUNTIME_LEASE_MS`, 90 s, at a ~31 s
 * cadence). When it halts -- exit 3, which systemd deliberately does not
 * restart (docs/ops/amux/wsl-execution-bridge.md, "halt와 재시작") -- or the
 * host or its network goes away, every lease runs out and nothing renews it.
 * Between 2026-10-05 and 2026-10-10 that went unnoticed for 21 to 37 hours
 * at a time, four times. docs/ops/amux/bridge-monitoring.md is the runbook.
 *
 * Only the lease times are read. Which worker, what it was doing, and why the
 * bridge stopped stay out of this judgement and out of the alert: the cause is
 * read on the host.
 *
 * Pure: the infrastructure threshold monitor reads the rows and reports.
 */

/**
 * How long every lease may have been out before the bridge is reported lost.
 * A restart registers again within seconds, so this only absorbs a run that
 * lands in the moment between a lease running out and a fresh one.
 */
export const AMUX_BRIDGE_LOST_AFTER_MS = 5 * 60 * 1_000;

/**
 * A lease that ran out longer ago than this belongs to a bridge that is gone
 * for good -- moved, retired, or never coming back -- not to one that halted.
 * The reminders stop rather than repeat forever about a host nobody runs.
 */
export const AMUX_BRIDGE_WATCH_HORIZON_MS = 48 * 60 * 60 * 1_000;

/** How often a bridge that stays lost is reported again. */
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
 * followed by a fresh page. tests/amuxBridgeLivenessCore.test.mjs fails if
 * any other code path starts registering a runtime without being listed here.
 */
export const AMUX_NON_BRIDGE_WORKERS: readonly string[] = ["engineering-runner"];

export type AmuxBridgeLease = {
  readonly workerName: string;
  readonly leaseExpiresAt: Date;
};

export type AmuxBridgeLiveness =
  /** No lease inside the horizon: no bridge in this environment to watch. */
  | { readonly state: "unwatched" }
  | { readonly state: "live"; readonly liveRuntimes: number }
  /** Every lease is out, for less than `AMUX_BRIDGE_LOST_AFTER_MS`. */
  | { readonly state: "lapsing"; readonly lostSince: Date }
  | {
      readonly state: "lost";
      readonly lostSince: Date;
      readonly watchedRuntimes: number;
    };

/** The oldest lease expiry the judgement looks at. */
export const amuxBridgeWatchHorizonStart = (now: Date) =>
  new Date(now.getTime() - AMUX_BRIDGE_WATCH_HORIZON_MS);

export function judgeAmuxBridgeLiveness(
  leases: readonly AmuxBridgeLease[],
  now: Date
): AmuxBridgeLiveness {
  const horizon = amuxBridgeWatchHorizonStart(now).getTime();
  const watched = leases
    .filter((lease) => !AMUX_NON_BRIDGE_WORKERS.includes(lease.workerName))
    .map((lease) => lease.leaseExpiresAt.getTime())
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > horizon);
  if (watched.length === 0) return { state: "unwatched" };

  // A lease that runs out exactly now is out: the claim path reads it the same
  // way (lib/agentOfficeAmuxState.ts, lib/amux/workerRuntime.ts).
  const liveRuntimes = watched.filter((expiresAt) => expiresAt > now.getTime()).length;
  if (liveRuntimes > 0) return { state: "live", liveRuntimes };

  const lostSince = new Date(Math.max(...watched));
  if (now.getTime() - lostSince.getTime() < AMUX_BRIDGE_LOST_AFTER_MS) {
    return { state: "lapsing", lostSince };
  }
  return { state: "lost", lostSince, watchedRuntimes: watched.length };
}
