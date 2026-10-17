import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { dmKeyPeriodEndMs, dmKeyPeriodOf } from "@/lib/amux/decisionMakerBodyCore";
import {
  destroyDecisionMakerDigestKey,
  listDecisionMakerPurgeCandidates,
  purgeDecisionMakerBodies,
  readDecisionMakerDigestKeyRegistry,
  rotateDecisionMakerDigestKey,
  type DecisionMakerDigestKeyRegistry,
} from "@/lib/amux/decisionMakerBodyStore";
import {
  decisionMakerPeriodKey,
  loadDecisionMakerDigestKeyRing,
  type DmDigestKeyRing,
} from "@/lib/amux/decisionMakerDigestKeys";
import {
  listDecisionMakerStaleCloseCandidates,
  recordDecisionMakerValidationLatch,
  staleCloseDecisionMakerRequest,
} from "@/lib/amux/decisionMakerRequestStore";
import { DM_INSTANCE_SCOPES, type DmInstanceScope } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * The AMUX Decision Maker's system retention work
 * (docs/policy/amux-decision-maker.md §10), run on the fifteen-minute
 * maintenance schedule: put the current and the next key period's key into
 * use, close requests left open for 720 hours (`stale_close`), delete the
 * bodies whose retention has passed (`body_purge`), and record the
 * destruction of an ended period's key once no body of it remains.
 *
 * First, since 2026-10-17, §8's validation latch for each instance: the result
 * route checks it once a validation failure commits, and this is the check
 * that writes a latch whose first check did not commit (the request store
 * finds any run of three since the instance's newest switch event). It comes
 * before the retention work so that a retention error cannot hold it back,
 * and it has a failure boundary of its own, per instance: a check that fails
 * -- a switch read, a result it cannot read, a transaction -- is logged by its
 * code and counted, and neither the other instance's check nor any retention
 * step waits on it. An owed latch is not left to this check meanwhile: a
 * routing and a transmission intent refuse the instance themselves.
 *
 * Every candidate is read first, in one read transaction, and each is then
 * written in a transaction of its own inside the AMUX DB boundary, by the
 * store that owns it -- which decides again under its lock, so a candidate
 * that stopped qualifying in between is a refusal, never a write. §6's table
 * allows all of it under the kill switch, and a latch only turns an instance
 * off, so no switch is read here; the latch check reads the instance's newest
 * switch event in its own store.
 *
 * An error of the retention work stops it where it is (foundation principle 7). Nothing is
 * sent again in the same run: a write whose outcome is unknown is settled by
 * the next run's read, which no longer lists what committed (§10: "결과를
 * 모르면 다시 읽어 행이 남았는지로 확정한다"). The sweep never throws.
 *
 * There is nothing to do until stage S2 routes a question; the sweep is then
 * two latch checks of three statements each and a read of three every
 * fifteen minutes.
 */

/** At most this many stale closes and this many purges per run. */
export const DM_RETENTION_SWEEP_LIMIT = 20;

export type DecisionMakerRetentionCandidates = {
  staleRequestIds: string[];
  purgeRequestIds: string[];
  registry: DecisionMakerDigestKeyRegistry;
};

type CandidateReader = Parameters<typeof readDecisionMakerDigestKeyRegistry>[0];

/** The sweep's read, in three statements: the stale requests, the purgeable requests, the key registry. */
export async function readDecisionMakerRetentionCandidates(
  client: CandidateReader,
  limit = DM_RETENTION_SWEEP_LIMIT,
): Promise<DecisionMakerRetentionCandidates> {
  const staleRequestIds = await listDecisionMakerStaleCloseCandidates(client, { limit });
  const purgeRequestIds = await listDecisionMakerPurgeCandidates(client, { limit });
  const registry = await readDecisionMakerDigestKeyRegistry(client);
  return { staleRequestIds, purgeRequestIds, registry };
}

/**
 * The periods whose key to put into use: the current and the next by the
 * database clock (the store refuses any further ahead), each only when the
 * ring holds its key and the registry has neither rotated nor destroyed it.
 */
export const dmKeyPeriodsToRotate = (
  registry: DecisionMakerDigestKeyRegistry,
  ring: DmDigestKeyRing,
): number[] => {
  const current = dmKeyPeriodOf(registry.dbNowMs);
  return [current, current + 1].filter(
    (period) =>
      decisionMakerPeriodKey(ring, period) !== null &&
      !registry.periods.some((entry) => entry.keyPeriod === period && (entry.rotated || entry.destroyed)),
  );
};

/**
 * The periods whose key to destroy: rotated, not destroyed, ended by the
 * database clock, and with no body left. The store still refuses one with an
 * open hold or an open request.
 */
export const dmKeyPeriodsToDestroy = (registry: DecisionMakerDigestKeyRegistry): number[] =>
  registry.periods
    .filter(
      (entry) =>
        entry.rotated && !entry.destroyed && !entry.hasBodies && dmKeyPeriodEndMs(entry.keyPeriod) <= registry.dbNowMs,
    )
    .map((entry) => entry.keyPeriod);

export type DmRetentionSweepStep = "read" | "rotate" | "stale_close" | "purge" | "destroy";

export type DecisionMakerRetentionSweepResult = {
  /** Instances §8's validation latch turned off in this run. */
  validationLatched: number;
  /** Instances whose latch check failed in this run; each is logged by its code. */
  validationLatchUnsettled: number;
  /** Whether the key ring could be loaded; without it no key is rotated in. */
  keyRing: "loaded" | "not_configured" | "malformed";
  keysRotated: number;
  staleClosed: number;
  purged: number;
  keysDestroyed: number;
  /** Candidates a store refused when it decided again under its lock. */
  refused: number;
  /** Where an error stopped the sweep, with its code; null when it ran through. */
  stopped: { step: DmRetentionSweepStep; code: string | null } | null;
};

export type DecisionMakerRetentionSweepDeps = {
  validationLatch: (instance: DmInstanceScope) => Promise<{ latched: boolean }>;
  readCandidates: () => Promise<DecisionMakerRetentionCandidates>;
  loadKeyRing: () => DmDigestKeyRing;
  rotate: (keyPeriod: number, ring: DmDigestKeyRing) => Promise<{ recorded: boolean }>;
  staleClose: (requestId: string) => Promise<{ recorded: boolean }>;
  purge: (requestId: string) => Promise<{ deleted: boolean }>;
  destroy: (keyPeriod: number) => Promise<{ recorded: boolean }>;
};

/** The real collaborators: each in its own transaction, inside its AMUX DB boundary. */
export const decisionMakerRetentionSweepDeps = (
  overrides: Partial<DecisionMakerRetentionSweepDeps> = {},
): DecisionMakerRetentionSweepDeps => ({
  validationLatch: (instance) =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerValidationLatch, (tx) =>
      recordDecisionMakerValidationLatch(tx, { instance }),
    ),
  readCandidates: () =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRetentionRead, (tx) => readDecisionMakerRetentionCandidates(tx)),
  loadKeyRing: () => loadDecisionMakerDigestKeyRing(),
  rotate: (keyPeriod, keyRing) =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDigestKeyRotate, (tx) =>
      rotateDecisionMakerDigestKey(tx, { keyPeriod, keyRing }),
    ),
  staleClose: (requestId) =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerStaleClose, (tx) =>
      staleCloseDecisionMakerRequest(tx, { requestId }),
    ),
  purge: (requestId) =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerBodyPurge, (tx) => purgeDecisionMakerBodies(tx, { requestId })),
  destroy: (keyPeriod) =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDigestKeyDestroy, (tx) =>
      destroyDecisionMakerDigestKey(tx, { keyPeriod }),
    ),
  ...overrides,
});

/**
 * The code of an error from one of the four modules the sweep calls, read by
 * the name each class sets on itself rather than `instanceof`, so a second
 * copy of a module (two import specifiers, one file) still reports its code.
 * The names are literals because a minified class loses its own. Anything
 * else is null: no message, which could carry a value, reaches the log.
 */
const SWEEP_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AmuxDbBoundaryError",
  "DecisionMakerBodyWriteError",
  "DecisionMakerRequestWriteError",
  "DecisionMakerDigestKeyError",
]);
const errorCode = (error: unknown): string | null => {
  if (!(error instanceof Error) || !SWEEP_ERROR_NAMES.has(error.name)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
};

class SweepStop extends Error {
  constructor(
    readonly step: DmRetentionSweepStep,
    readonly failure: unknown,
  ) {
    super(`AMUX Decision Maker retention sweep stopped at ${step}`);
  }
}

/** One sweep with the given collaborators. Never throws. */
export async function runDecisionMakerRetentionSweep(
  deps: DecisionMakerRetentionSweepDeps,
): Promise<DecisionMakerRetentionSweepResult> {
  const result: DecisionMakerRetentionSweepResult = {
    validationLatched: 0,
    validationLatchUnsettled: 0,
    keyRing: "not_configured",
    keysRotated: 0,
    staleClosed: 0,
    purged: 0,
    keysDestroyed: 0,
    refused: 0,
    stopped: null,
  };
  const step = async <T>(name: DmRetentionSweepStep, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new SweepStop(name, error);
    }
  };
  // §8's latch check, one failure boundary per instance: a failed check is
  // counted and logged by its code, and stops nothing else.
  for (const instance of DM_INSTANCE_SCOPES) {
    try {
      const written = await deps.validationLatch(instance);
      if (written.latched) result.validationLatched += 1;
    } catch (error) {
      result.validationLatchUnsettled += 1;
      console.warn(
        JSON.stringify({
          subsystem: "amux",
          event: "decision_maker_validation_latch_check_failed",
          instance,
          code: errorCode(error),
        }),
      );
    }
  }

  try {
    const candidates = await step("read", deps.readCandidates);

    // No ring is the state until the operator sets AMUX_DM_DIGEST_KEYS, and
    // says nothing: only a ring that is set and cannot be read is reported.
    const ring = ((): DmDigestKeyRing | null => {
      try {
        const loaded = deps.loadKeyRing();
        result.keyRing = "loaded";
        return loaded;
      } catch (error) {
        result.keyRing = errorCode(error) === "not_configured" ? "not_configured" : "malformed";
        if (result.keyRing === "malformed") {
          console.warn(JSON.stringify({ subsystem: "amux", event: "decision_maker_retention_key_ring_unreadable" }));
        }
        return null;
      }
    })();
    if (ring) {
      for (const keyPeriod of dmKeyPeriodsToRotate(candidates.registry, ring)) {
        const written = await step("rotate", () => deps.rotate(keyPeriod, ring));
        if (written.recorded) result.keysRotated += 1;
        else result.refused += 1;
      }
    }
    for (const requestId of candidates.staleRequestIds) {
      const written = await step("stale_close", () => deps.staleClose(requestId));
      if (written.recorded) result.staleClosed += 1;
      else result.refused += 1;
    }
    for (const requestId of candidates.purgeRequestIds) {
      const written = await step("purge", () => deps.purge(requestId));
      if (written.deleted) result.purged += 1;
      else result.refused += 1;
    }
    for (const keyPeriod of dmKeyPeriodsToDestroy(candidates.registry)) {
      const written = await step("destroy", () => deps.destroy(keyPeriod));
      if (written.recorded) result.keysDestroyed += 1;
      else result.refused += 1;
    }
  } catch (error) {
    const stop = error instanceof SweepStop ? error : new SweepStop("read", error);
    result.stopped = { step: stop.step, code: errorCode(stop.failure) };
    console.warn(
      JSON.stringify({
        subsystem: "amux",
        event: "decision_maker_retention_sweep_stopped",
        step: result.stopped.step,
        code: result.stopped.code,
      }),
    );
  }
  return result;
}

/** The maintenance schedule's entry point: the sweep with its real collaborators. Never throws. */
export async function runDecisionMakerRetentionMaintenanceQuietly(): Promise<DecisionMakerRetentionSweepResult> {
  return runDecisionMakerRetentionSweep(decisionMakerRetentionSweepDeps());
}
