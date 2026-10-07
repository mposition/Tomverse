/**
 * The only module that writes the engineering agent's tables.
 *
 * Contract: docs/policy/engineering-agent.md §11. `npm run
 * check:protected-table-writers` refuses a write to any `EngineeringAgent*`
 * table anywhere else. The migration 20260928120000_engineering_agent_state
 * holds the rules a direct writer cannot get round -- transitions, fencing,
 * leases, single consumption, owner-queue caps, deferred companions. This
 * module adds what the database cannot see:
 *
 * - every change and its audit entry commit together. System actions are
 *   written with `writeSystemAuditLog` under one of the engineering actors,
 *   human ones with `writeAdminAuditLog`; metadata carries ids, enums and
 *   digests only;
 * - the transition a result leads to is decided by lib/engineeringAgentCore.ts,
 *   never by the caller naming a target state;
 * - a patch is checked against its digest, its size and the app's own secret
 *   patterns before it is stored; a hit stores nothing;
 * - JSON columns are parsed with strict schemas, and person identifiers never
 *   go into them: the reviewer lives in its own columns, which retention can
 *   clear, and a merge observation names only the kind of actor that merged.
 *
 * Rows are locked in the cross lock order of lib/engineeringAgentStateMismatch.ts
 * (run, work item, capability, binding) and each audit entry is written last,
 * after every row it describes is locked.
 *
 * What it does not do: permission and step-up checks are the route's; AMUX rows
 * are the AMUX store's, reached only through the engineering adapter, which
 * calls into this module inside the same transaction. A registration record is
 * written in the AMUX agent intake writer's transaction, beside its card.
 *
 * Reads are not restricted: any module may query these tables. It is writing
 * that goes through here.
 */

import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { Session } from "next-auth";
import { z } from "zod";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import type { EngineeringAgentSystemAuditActor } from "@/lib/adminAuditSystemActors";
import type { AmuxAttachedTransaction } from "@/lib/amux/dbBoundary";
import { AMUX_V22_ENGINEERING_PUBLICATION_ENV,
  amuxV22EngineeringPublicationEnabled } from
  "@/lib/amux/v22TaskExecutionCore";
import { readAmuxV22PublicPrConsent } from
  "@/lib/amux/v22PublicPrConsent";
import { writeEngineeringAgentSystemAudit as systemAudit } from "@/lib/engineeringAgentAudit";
import { REGISTRATION_CAPS } from "@/lib/engineeringAgentRegistrationGuard";
import { decideMismatchAction, type MismatchAction } from "@/lib/engineeringAgentStateMismatch";
import {
  ENGINEERING_AGENT_VERIFIER_VERSION,
  capabilityCommitObject,
  issueCapability,
  type IssueInput,
} from "@/lib/engineeringAgentCapability";
import {
  ENGINEERING_AGENT_HALT_ACKNOWLEDGED_SETTING_KEY,
  ENGINEERING_AGENT_FREEZE_SETTING_KEY,
  ENGINEERING_AGENT_KILL_SWITCH_ENV,
  ENGINEERING_AGENT_MONITORS_CONFIRMED_SETTING_KEY,
  ENGINEERING_AGENT_OBSERVED_HALT_SETTING_KEY,
  OBSERVABLE_HALTS,
  higherHalt,
  type ObservableHalt,
  ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY,
  ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY,
  HALT_VALUES,
  ENGINEERING_AGENT_MERGER_KINDS,
  ENGINEERING_AGENT_MODE_SETTING_KEY,
  ENGINEERING_AGENT_NOT_APPROVED_REASONS,
  ENGINEERING_AGENT_POLICY_VERSION,
  ENGINEERING_AGENT_REGISTRATION_SETTING_KEY,
  QUEUE_TTL_DAYS,
  WRITE_ITEM_KINDS,
  decideArmedGate,
  decideOwnerQueues,
  decideWriteItemTransition,
  engineeringBranchName,
  isCircuitLatched,
  isRunId,
  partialRegistrationDecisionCauseKey,
  parseEngineeringAgentMode,
  parseSettingInstant,
  resolveEngineeringAgentSwitches,
  unknownOutcomeDecisionCauseKey,
  writeItemStates,
  type EffectiveSwitches,
  type HaltValue,
  type QueueVerdict,
  type RunOutcome,
  type WriteClaimMode,
  type WriteClaimPrecondition,
  type WriteItemKind,
  type WriteItemState,
  type WriteResultOutcome,
  type WriteTransitionContext,
} from "@/lib/engineeringAgentCore";
import { detectSecrets } from "@/lib/engineeringAgentSecretPatterns";

/* ------------------------------------------------------------------------- */
/* Transactions and refusals                                                  */
/* ------------------------------------------------------------------------- */

declare const ENGINEERING_AGENT_TRANSACTION_BRAND: unique symbol;

/**
 * A client that is provably inside a transaction, for the reason
 * lib/marketingStore.ts gives: `Prisma.TransactionClient` accepts a whole
 * `PrismaClient`, and then a change and its audit entry would each go out on
 * their own autocommit. The only value of this type is one
 * `runEngineeringAgentTransaction()` produced.
 */
export type EngineeringAgentTransaction = Prisma.TransactionClient & {
  readonly [ENGINEERING_AGENT_TRANSACTION_BRAND]: "engineering-agent";
};

/**
 * The one place an `EngineeringAgentTransaction` comes from. Its first
 * statement takes the audit chain's lock, the one lock order this app has
 * (lib/adminAudit.ts, `takeAuditChainLock`): every engineering write ends in
 * an audit entry, and the halt and owner-queue locks come after it, so an
 * engineering transaction and an AMUX writer carrying an engineering
 * attachment -- which has taken the audit lock before its attachment runs --
 * take the locks they share in the same order.
 */
export async function runEngineeringAgentTransaction<T>(
  client: PrismaClient,
  run: (tx: EngineeringAgentTransaction) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
    /**
     * AMUX row locks the work needs, taken first: every AMUX row lock comes
     * before the audit chain (§11). Only lockEngineeringAgentMismatchAmuxRows
     * is passed here.
     */
    beforeAuditLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
): Promise<T> {
  return client.$transaction(async (tx) => {
    await options?.beforeAuditLock?.(tx);
    await takeAuditChainLock(tx);
    return run(tx as unknown as EngineeringAgentTransaction);
  }, options);
}

/**
 * The other place: an AMUX writer's own transaction, lent to the engineering
 * adapter for the rows that must commit with the AMUX write (policy §11: a run
 * is created in the transaction that starts its AMUX attempt). The AMUX brand
 * already proves what this brand exists to prove -- that the client is an
 * open transaction and not a whole PrismaClient -- so this only renames it.
 */
export function engineeringAgentTransactionInAmux(tx: AmuxAttachedTransaction): EngineeringAgentTransaction {
  return tx as unknown as EngineeringAgentTransaction;
}

/** Read-lock the run while a v22 Task chooses its one private/public product.
 * AMUX attempt and card locks must already be held in the cross lock order. */
export async function lockEngineeringAgentV22Run(
  tx: EngineeringAgentTransaction, attemptId: string,
): Promise<{ id: string; cardId: string; baseSha: string;
  status: string; modeAtStart: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; cardId: string;
    baseSha: string; status: string; modeAtStart: string }>>`
    SELECT "id", "cardId", "baseSha", "status", "modeAtStart"
    FROM "EngineeringAgentRun" WHERE "amuxAttemptId" = ${attemptId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** A write refused before it reached the database. The code is an enum, never text from outside. */
export class EngineeringAgentStoreRefusedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`engineering agent store refused: ${code}`);
    this.name = "EngineeringAgentStoreRefusedError";
    this.code = code;
  }
}

const refuse = (code: string): never => {
  throw new EngineeringAgentStoreRefusedError(code);
};

/** The database's clock, in UTC, as every trigger reads it. */
const databaseNow = async (tx: EngineeringAgentTransaction): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `;
  return rows[0].now;
};

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/* ------------------------------------------------------------------------- */
/* Audit                                                                      */
/* ------------------------------------------------------------------------- */

export const ENGINEERING_AGENT_AUDIT_ACTIONS = Object.freeze({
  runStarted: "engineering_agent.run_started",
  runEnded: "engineering_agent.run_ended",
  workItemOpened: "engineering_agent.work_item_opened",
  workItemClaimed: "engineering_agent.work_item_claimed",
  workItemSettled: "engineering_agent.work_item_settled",
  workItemLeaseExpired: "engineering_agent.work_item_lease_expired",
  workItemExpired: "engineering_agent.work_item_expired",
  capabilityIssued: "engineering_agent.capability_issued",
  t2Decided: "engineering_agent.t2_decision",
  decisionAcknowledged: "engineering_agent.decision_acknowledged",
  bindingRecorded: "engineering_agent.binding_recorded",
  bindingReplaced: "engineering_agent.binding_replaced",
  bindingMoved: "engineering_agent.binding_moved",
  bindingObserved: "engineering_agent.binding_observed",
  mismatchActed: "engineering_agent.mismatch_acted",
  reviewerRemoved: "engineering_agent.reviewer_removed",
  switchChanged: "engineering_agent.switch_changed",
  registrationRecorded: "engineering_agent.registration_recorded",
  registrationResolved: "engineering_agent.registration_resolved",
  haltAcknowledged: "engineering_agent.halt_acknowledged",
  monitorsConfirmed: "engineering_agent.monitors_confirmed",
  serviceFinished: "engineering_agent.service_finished",
  haltObserved: "engineering_agent.halt_observed",
} as const);

const humanActorId = (session: Session): string =>
  session.user?.id ? session.user.id : refuse("session_without_user");

/* ------------------------------------------------------------------------- */
/* Mode, freeze and kill switch                                               */
/* ------------------------------------------------------------------------- */

/**
 * The effective switches. A read that fails at all is `off` and frozen
 * (lib/engineeringAgentCore.ts); the kill switch is the environment's and
 * wins over every stored value.
 */
export async function readEngineeringAgentSwitches(
  db: PrismaClient | Prisma.TransactionClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EffectiveSwitches> {
  const keys = [
    ENGINEERING_AGENT_MODE_SETTING_KEY,
    ENGINEERING_AGENT_FREEZE_SETTING_KEY,
    ENGINEERING_AGENT_REGISTRATION_SETTING_KEY,
  ];
  let rows: Array<{ key: string; value: string }> | null;
  try {
    rows = await db.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  } catch {
    rows = null;
  }
  const value = (key: string) => rows?.find((row) => row.key === key)?.value ?? null;
  return resolveEngineeringAgentSwitches({
    mode: value(ENGINEERING_AGENT_MODE_SETTING_KEY),
    freeze: value(ENGINEERING_AGENT_FREEZE_SETTING_KEY),
    registration: value(ENGINEERING_AGENT_REGISTRATION_SETTING_KEY),
    killSwitch: env[ENGINEERING_AGENT_KILL_SWITCH_ENV],
    readFailed: rows === null,
  });
}

/**
 * Which switch a write needs. The database refuses a run while the mode is off
 * or frozen; the environment kill switch lives only here, so every claim,
 * capability, publish and maintenance write reads the switches in its own
 * transaction and refuses when they say no. Recording what already happened
 * -- a claim's result, a pull request the publisher opened, a person's
 * decision, a run's end -- is never refused by a switch.
 */
export type EngineeringAgentSwitchGate =
  | "claimAllowed"
  | "publishAllowed"
  | "registrationAllowed"
  | "maintenanceAllowed";

const requireSwitch = async (tx: EngineeringAgentTransaction, gate: EngineeringAgentSwitchGate) => {
  const switches = await readEngineeringAgentSwitches(tx);
  if (!switches[gate]) refuse(`switch_refused_${gate}`);
};

/* ------------------------------------------------------------------------- */
/* Halt                                                                       */
/* ------------------------------------------------------------------------- */

export type EngineeringAgentHaltState = {
  openStateMismatches: number;
  /**
   * Active runs whose AMUX attempt has already ended -- a mismatch that is
   * real before anyone has opened its item (§11).
   */
  orphanedRuns: number;
  /**
   * The latest halt a run recorded after the last Admin acknowledgement, or
   * null when none has. A recorded halt holds until a person acknowledges it
   * (§12); a later run that ends clean does not clear it.
   */
  unacknowledgedHalt: HaltValue | null;
  circuitLatched: boolean;
};

// A halt the database holds that this build does not know is still a halt.
const storedHalt = (raw: string): HaltValue =>
  (HALT_VALUES as readonly string[]).includes(raw) ? (raw as HaltValue) : "config_missing";

/**
 * Everything that writes a halt (a run's end, an opened state mismatch) and
 * everything that decides under one (a run's start, a write claim that spends
 * a capability) takes this lock first, so a decision never reads the halts
 * from before a halt that commits ahead of it. The order is the audit chain's
 * lock, then this one, then the owner-queue lock a run's, draft's, publish
 * item's or binding's INSERT takes; in an adapter transaction all three come
 * after every AMUX row lock.
 */
const lockEngineeringAgentHalt = async (tx: EngineeringAgentTransaction) => {
  await takeAuditChainLock(tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('engineering-agent:halt'))`;
};

/**
 * What the app itself knows about a halt (§12): an open state mismatch, a
 * halt a run recorded since the last Admin acknowledgement, and whether
 * repeated incidents latched the circuit since then. The unbound pull
 * request and ref readings are the runner's, recorded on the runs it ends.
 * Only the acknowledgement clears a recorded halt or the circuit; the
 * passage of time and a clean run do not.
 */
export async function readEngineeringAgentHaltState(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<EngineeringAgentHaltState> {
  const openStateMismatches = await db.engineeringAgentWorkItem.count({ where: { kind: "state_mismatch", state: "open" } });
  const orphaned = await db.engineeringAgentRun.count({
    where: { status: "active", attempt: { endedAt: { not: null } } },
  });
  const acknowledgement = await db.appSetting.findUnique({
    where: { key: ENGINEERING_AGENT_HALT_ACKNOWLEDGED_SETTING_KEY },
    select: { value: true },
  });
  const terminated = await db.engineeringAgentRun.findMany({
    where: { status: { in: ["finished", "abandoned"] }, endedAt: { not: null } },
    orderBy: [{ endedAt: "asc" }, { id: "asc" }],
    select: { startedAt: true, endedAt: true, halt: true },
  });
  const acknowledgedAt = parseSettingInstant(acknowledgement?.value);
  const runs = terminated.map((run) => ({ startedAt: run.startedAt, endedAt: run.endedAt!, halt: storedHalt(run.halt) }));
  const recorded = runs.filter(
    (run) => run.halt !== "none" && (acknowledgedAt === null || run.endedAt.getTime() > acknowledgedAt.getTime()),
  );
  const fromRuns = recorded.length === 0 ? null : recorded[recorded.length - 1].halt;
  // An observation outside a run halts the same way, until acknowledged.
  const observedSetting = await db.appSetting.findUnique({
    where: { key: ENGINEERING_AGENT_OBSERVED_HALT_SETTING_KEY },
    select: { value: true },
  });
  const observed = parseObservedHalt(observedSetting?.value);
  const observedHalt =
    observed !== null && (acknowledgedAt === null || observed.at.getTime() > acknowledgedAt.getTime())
      ? observed.halt
      : null;
  return {
    openStateMismatches,
    orphanedRuns: orphaned,
    unacknowledgedHalt:
      fromRuns === null ? observedHalt : observedHalt === null ? fromRuns : higherHalt(fromRuns, observedHalt),
    circuitLatched: isCircuitLatched({ runs, acknowledgedAt }),
  };
}

const parseObservedHalt = (value: string | undefined): { halt: HaltValue; at: Date } | null => {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as { halt?: unknown; at?: unknown };
    const at = typeof parsed.at === "string" ? parseSettingInstant(parsed.at) : null;
    if (at === null || !(OBSERVABLE_HALTS as readonly unknown[]).includes(parsed.halt)) return null;
    return { halt: parsed.halt as HaltValue, at };
  } catch {
    return null;
  }
};

/**
 * The one halt value a service is told, so it can decide its dead-man signal
 * (§12: no success signal while halted): what a person must acknowledge
 * first, then a latched circuit, then an open mismatch or orphaned run.
 */
export const currentEngineeringAgentHalt = (state: EngineeringAgentHaltState): HaltValue => {
  if (state.unacknowledgedHalt !== null) {
    return state.circuitLatched ? higherHalt(state.unacknowledgedHalt, "circuit_open") : state.unacknowledgedHalt;
  }
  if (state.circuitLatched) return "circuit_open";
  if (state.openStateMismatches > 0 || state.orphanedRuns > 0) return "state_mismatch";
  return "none";
};

/**
 * What the agent itself may have put on GitHub (§12), with what it put there:
 * each current binding's run, pull request and heads, and each consumed
 * capability's run and commit digest -- a write was allowed exactly that
 * commit, whatever became of it. Identifiers and digests only. A branch or
 * pull request under the agent's namespace that none of this accounts for,
 * by content and not only by name, is unbound.
 */
export async function readEngineeringAgentKnownPublishes(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<{
  bindings: Array<{ runId: string; prNumber: number; headSha: string; verifiedHeadSha: string }>;
  consumed: Array<{ runId: string; commitDigest: string }>;
}> {
  const [capabilities, bindings] = await Promise.all([
    db.engineeringAgentCapability.findMany({
      where: { consumedAt: { not: null } },
      orderBy: [{ consumedAt: "asc" }, { id: "asc" }],
      select: { commitDigest: true, workItem: { select: { runId: true } } },
    }),
    db.engineeringAgentBinding.findMany({
      where: { supersededAt: null },
      orderBy: [{ prNumber: "asc" }, { id: "asc" }],
      select: { runId: true, prNumber: true, headSha: true, verifiedHeadSha: true },
    }),
  ]);
  return {
    bindings,
    consumed: capabilities
      .filter((row) => row.workItem.runId !== null)
      .map((row) => ({ runId: row.workItem.runId as string, commitDigest: row.commitDigest })),
  };
}

/** How many runs one mismatch sweep looks at. */
export const ENGINEERING_AGENT_MISMATCH_SWEEP = 20;

/**
 * Opens a state mismatch for each active run whose AMUX attempt has already
 * ended -- AMUX recovery reclaimed an expired attempt, which it may do on its
 * own route without the engineering row (§11). The run is not ended to match:
 * the mismatch goes to a person, and while it is open everything halts. A
 * run already reported is not reported twice (its cause key is unique).
 */
export async function openEngineeringAgentRunMismatches(tx: EngineeringAgentTransaction): Promise<number> {
  const runs = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT r."id" FROM "EngineeringAgentRun" r
    JOIN "AmuxExecutionAttempt" a ON a."id" = r."amuxAttemptId"
    WHERE r."status" = 'active' AND a."endedAt" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "EngineeringAgentWorkItem" w WHERE w."causeKey" = 'run_attempt:' || r."id"
      )
    ORDER BY r."startedAt", r."id"
    LIMIT ${ENGINEERING_AGENT_MISMATCH_SWEEP}
  `;
  for (const run of runs) {
    await openEngineeringAgentWorkItem(tx, {
      kind: "state_mismatch",
      causeKey: `run_attempt:${run.id}`,
      runId: run.id,
      reason: "attempt_ended_run_active",
    });
  }
  return runs.length;
}

/** Whether anything halts claims, runs and pushes (§12). */
export const engineeringAgentHalted = (state: EngineeringAgentHaltState): boolean =>
  state.openStateMismatches > 0 ||
  state.orphanedRuns > 0 ||
  state.unacknowledgedHalt !== null ||
  state.circuitLatched;

/**
 * Whether a run may start at all, asked before AMUX writes anything for it
 * (§2.1: a skip is before the claim, because a refusal after it spends an
 * attempt): the switches allow a claim, nothing halts, and both owner queues
 * have room. The run's INSERT asks the database again.
 */
export async function requireEngineeringAgentRunAdmission(tx: EngineeringAgentTransaction): Promise<void> {
  await requireSwitch(tx, "claimAllowed");
  await lockEngineeringAgentHalt(tx);
  if (engineeringAgentHalted(await readEngineeringAgentHaltState(tx))) refuse("halted");
  const { mode } = await readEngineeringAgentSwitches(tx);
  if (!(await readEngineeringAgentOwnerQueues(tx, mode)).claimAllowed) refuse("owner_queue_full");
}

/* ------------------------------------------------------------------------- */
/* Owner queues                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Whether the owner queues have room for another run, counted as the run
 * trigger counts them (migration `engineering_agent_state`): an active run
 * may still become a pull request or a decision, and a publish item not yet
 * settled may still become a binding. The trigger stays the authority at the
 * run's INSERT; this reading lets the worker stop offering itself for cards
 * before AMUX assigns one it would have to refuse (§2.1).
 */
export async function readEngineeringAgentOwnerQueues(
  db: PrismaClient | Prisma.TransactionClient,
  mode: EffectiveSwitches["mode"],
): Promise<QueueVerdict> {
  const rows = await db.$queryRaw<
    Array<{ openPrs: bigint; pendingDecisions: bigint; activeRuns: bigint; t1Started: Date | null; now: Date }>
  >`
    SELECT
      (SELECT count(*) FROM "EngineeringAgentBinding" b
        WHERE b."state" IN ('open', 'closed') AND b."supersededAt" IS NULL)
      + (SELECT count(*) FROM "EngineeringAgentWorkItem" w
        WHERE w."kind" = 'publish' AND w."state" IN ('queued', 'claimed', 'needs_lookup', 'outcome_unknown'))
        AS "openPrs",
      (SELECT count(*) FROM "EngineeringAgentWorkItem" w
        WHERE w."kind" IN ('t2_draft', 'decision', 'state_mismatch') AND w."state" = 'open') AS "pendingDecisions",
      (SELECT count(*) FROM "EngineeringAgentRun" r WHERE r."status" = 'active') AS "activeRuns",
      (SELECT min(r."startedAt") FROM "EngineeringAgentRun" r WHERE r."modeAtStart" = 't1') AS "t1Started",
      clock_timestamp() AT TIME ZONE 'UTC' AS "now"
  `;
  const row = rows[0];
  const activeRuns = Number(row.activeRuns);
  return decideOwnerQueues({
    openPrBindings: Number(row.openPrs) + activeRuns,
    pendingDecisions: Number(row.pendingDecisions) + activeRuns,
    // The trigger opens the first T1 window with the first run under `t1`.
    t1StartedAt: row.t1Started ?? (mode === "t1" ? row.now : null),
    now: row.now,
  });
}

/* ------------------------------------------------------------------------- */
/* Internal request idempotency (§10)                                         */
/* ------------------------------------------------------------------------- */

const REQUEST_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const REQUEST_ROUTE = /^[a-z]+\/[a-z-]+$/;
const RESULT_REF = /^(?:[0-9]{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type RequestAcceptance =
  | { outcome: "accepted" }
  /** The same request was seen before: its recorded state is the answer, and nothing starts again. */
  | { outcome: "replay"; state: string; resultRef: string | null }
  /** The key was used for a different request. */
  | { outcome: "conflict" };

/**
 * Records a request before any of its work, or reports the one already
 * recorded under its key. A caller that gets `replay` answers from the
 * recorded state and does not repeat the work, even when that state is
 * `in_progress` -- a COMMIT can land late (§10).
 */
export async function acceptEngineeringAgentRequest(
  tx: EngineeringAgentTransaction,
  input: { key: string; route: string; requestDigest: string },
): Promise<RequestAcceptance> {
  if (!REQUEST_KEY.test(input.key)) refuse("request_key_invalid");
  if (!REQUEST_ROUTE.test(input.route)) refuse("request_route_invalid");
  if (!SHA256.test(input.requestDigest)) refuse("request_digest_invalid");
  const existing = await tx.engineeringAgentRequest.findUnique({
    where: { key: input.key },
    select: { route: true, requestDigest: true, state: true, resultRef: true },
  });
  if (existing) {
    return existing.route === input.route && existing.requestDigest === input.requestDigest
      ? { outcome: "replay", state: existing.state, resultRef: existing.resultRef }
      : { outcome: "conflict" };
  }
  await tx.engineeringAgentRequest.create({
    data: { key: input.key, route: input.route, requestDigest: input.requestDigest },
  });
  return { outcome: "accepted" };
}

/** `accepted -> in_progress | aborted`, `in_progress -> committed | aborted`, once each. */
export async function moveEngineeringAgentRequest(
  tx: EngineeringAgentTransaction,
  input: {
    key: string;
    from: "accepted" | "in_progress";
    to: "in_progress" | "committed" | "aborted";
    /** On `committed` only: the run or item id a caller that lost its answer needs. */
    resultRef?: string | null;
  },
): Promise<void> {
  if (input.resultRef != null && (input.to !== "committed" || !RESULT_REF.test(input.resultRef))) {
    refuse("request_result_ref_invalid");
  }
  const moved = await tx.engineeringAgentRequest.updateMany({
    where: { key: input.key, state: input.from },
    data: input.resultRef != null ? { state: input.to, resultRef: input.resultRef } : { state: input.to },
  });
  if (moved.count !== 1) refuse("request_not_in_expected_state");
}

/* ------------------------------------------------------------------------- */
/* Runs                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Records a run. Called by the engineering adapter inside the transaction
 * that starts the AMUX execution attempt, so the two are one fact. The
 * trigger refuses a run while an owner queue is full and records the mode the
 * run started under.
 */
export async function recordEngineeringAgentRunStart(
  tx: EngineeringAgentTransaction,
  input: {
    runId: string;
    amuxAttemptId: string;
    cardId: string;
    cardKind: string;
    baseSha: string;
    leaseMs: number;
  },
): Promise<{ runId: string; modeAtStart: string; leaseExpiresAt: Date }> {
  if (!isRunId(input.runId)) refuse("run_id_invalid");
  if (!SHA1.test(input.baseSha)) refuse("base_sha_invalid");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) refuse("lease_invalid");
  await requireSwitch(tx, "claimAllowed");
  // A halt stops claims (§12), and a run is the claim's work.
  await lockEngineeringAgentHalt(tx);
  if (engineeringAgentHalted(await readEngineeringAgentHaltState(tx))) refuse("halted");
  const now = await databaseNow(tx);
  const run = await tx.engineeringAgentRun.create({
    data: {
      id: input.runId,
      amuxAttemptId: input.amuxAttemptId,
      cardId: input.cardId,
      cardKind: input.cardKind,
      baseSha: input.baseSha,
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
    },
    select: { id: true, modeAtStart: true, leaseExpiresAt: true },
  });
  await systemAudit(tx, "engineering-agent-runner", ENGINEERING_AGENT_AUDIT_ACTIONS.runStarted, "engineering_agent_run", run.id, {
    amuxAttemptId: input.amuxAttemptId,
    cardId: input.cardId,
    modeAtStart: run.modeAtStart,
  });
  return { runId: run.id, modeAtStart: run.modeAtStart, leaseExpiresAt: run.leaseExpiresAt };
}

/**
 * Extends a live lease. A lease that has run out stays out (the trigger's
 * rule). The AMUX attempt is named so a run's lease can move only with its own
 * attempt's.
 */
export async function heartbeatEngineeringAgentRun(
  tx: EngineeringAgentTransaction,
  input: { runId: string; amuxAttemptId: string; leaseMs: number },
): Promise<Date> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) refuse("lease_invalid");
  const now = await databaseNow(tx);
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  const moved = await tx.engineeringAgentRun.updateMany({
    where: {
      id: input.runId,
      amuxAttemptId: input.amuxAttemptId,
      status: "active",
      leaseExpiresAt: { gt: now, lt: leaseExpiresAt },
    },
    data: { leaseExpiresAt },
  });
  if (moved.count !== 1) refuse("run_lease_not_live");
  return leaseExpiresAt;
}

/**
 * Ends a run once. `abandoned` is its own status; every other outcome
 * finishes it. The AMUX attempt is named so a run ends only with its own.
 */
export async function endEngineeringAgentRun(
  tx: EngineeringAgentTransaction,
  input: { runId: string; amuxAttemptId: string; outcome: RunOutcome; halt: HaltValue },
): Promise<void> {
  const status = input.outcome === "abandoned" ? "abandoned" : "finished";
  await lockEngineeringAgentHalt(tx);
  const moved = await tx.engineeringAgentRun.updateMany({
    where: { id: input.runId, amuxAttemptId: input.amuxAttemptId, status: "active" },
    data: { status, outcome: input.outcome, halt: input.halt },
  });
  if (moved.count !== 1) refuse("run_not_active");
  await systemAudit(tx, "engineering-agent-runner", ENGINEERING_AGENT_AUDIT_ACTIONS.runEnded, "engineering_agent_run", input.runId, {
    status,
    outcome: input.outcome,
    halt: input.halt,
  });
}

/* ------------------------------------------------------------------------- */
/* Work items                                                                 */
/* ------------------------------------------------------------------------- */

/** The largest patch body the table holds (the migration's CHECK). */
export const ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES = 65_536;

const CAUSE_KEY = /^[a-z0-9_]{1,20}:[!-~]{1,200}$/;
const REASON = /^[a-z_]{1,64}$/;

export type OpenWorkItemInput =
  | {
      kind: "t2_draft";
      causeKey: string;
      runId: string;
      patchBody: string;
      patchDigest: string;
      baseSha: string;
      reason: string;
    }
  | {
      kind: "publish";
      causeKey: string;
      runId: string;
      patchBody: string;
      patchDigest: string;
      baseSha: string;
      expectedTreeId: string;
    }
  | { kind: "expire_close" | "prune"; causeKey: string; runId: string }
  | { kind: "decision" | "state_mismatch"; causeKey: string; runId: string | null; reason: string };

const OPENING_ACTOR: Record<OpenWorkItemInput["kind"], EngineeringAgentSystemAuditActor> = {
  t2_draft: "engineering-agent-runner",
  publish: "engineering-agent-runner",
  expire_close: "engineering-agent-observer",
  prune: "engineering-agent-observer",
  decision: "engineering-agent-observer",
  state_mismatch: "engineering-agent-observer",
};

/**
 * A patch is stored only if it is what its digest says, fits the column, and
 * trips none of the app's secret patterns -- the second check after the
 * runner's own (§11, "저장 전 검사"). A hit stores nothing and says only that
 * it happened. The database checks the digest again.
 */
const admitPatch = (patchBody: string, patchDigest: string, baseSha: string) => {
  if (Buffer.byteLength(patchBody, "utf8") > ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES) refuse("patch_too_large");
  if (sha256Hex(patchBody) !== patchDigest) refuse("patch_digest_mismatch");
  if (!SHA1.test(baseSha)) refuse("base_sha_invalid");
  if (detectSecrets(patchBody).length > 0) refuse("secret_detected");
};

/**
 * Opens a work item. A draft carries the patch the owner reads, a publish item
 * the patch the publisher applies; both are admitted by `admitPatch` first.
 */
export async function openEngineeringAgentWorkItem(
  tx: EngineeringAgentTransaction,
  input: OpenWorkItemInput,
): Promise<{ workItemId: string }> {
  if (!CAUSE_KEY.test(input.causeKey)) refuse("cause_key_invalid");
  if (input.kind === "publish") await requireSwitch(tx, "publishAllowed");
  if (input.kind === "expire_close" || input.kind === "prune") await requireSwitch(tx, "maintenanceAllowed");
  if (input.kind === "state_mismatch") await lockEngineeringAgentHalt(tx);
  const data: Prisma.EngineeringAgentWorkItemUncheckedCreateInput = {
    id: randomUUID(),
    kind: input.kind,
    state: input.kind === "t2_draft" || input.kind === "decision" || input.kind === "state_mismatch" ? "open" : "queued",
    causeKey: input.causeKey,
    runId: input.runId,
  };
  if (input.kind === "t2_draft") {
    if (!REASON.test(input.reason)) refuse("reason_invalid");
    admitPatch(input.patchBody, input.patchDigest, input.baseSha);
    Object.assign(data, {
      patchBody: input.patchBody,
      patchDigest: input.patchDigest,
      baseSha: input.baseSha,
      reason: input.reason,
    });
  } else if (input.kind === "publish") {
    if (!SHA1.test(input.expectedTreeId)) refuse("hash_invalid");
    admitPatch(input.patchBody, input.patchDigest, input.baseSha);
    Object.assign(data, {
      patchBody: input.patchBody,
      patchDigest: input.patchDigest,
      baseSha: input.baseSha,
      expectedTreeId: input.expectedTreeId,
    });
  } else if (input.kind === "decision" || input.kind === "state_mismatch") {
    if (!REASON.test(input.reason)) refuse("reason_invalid");
    data.reason = input.reason;
  }
  const created = await tx.engineeringAgentWorkItem.create({ data, select: { id: true } });
  await systemAudit(tx, OPENING_ACTOR[input.kind], ENGINEERING_AGENT_AUDIT_ACTIONS.workItemOpened, "engineering_agent_work_item", created.id, {
    kind: input.kind,
    runId: input.runId,
    patchDigest: "patchDigest" in input ? input.patchDigest : null,
  });
  return { workItemId: created.id };
}

type LockedWorkItem = {
  id: string;
  kind: string;
  state: string;
  runId: string | null;
  claimMode: string | null;
  fencingToken: bigint;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  patchDigest: string | null;
  baseSha: string | null;
};

const lockWorkItem = async (tx: EngineeringAgentTransaction, id: string): Promise<LockedWorkItem> => {
  const rows = await tx.$queryRaw<LockedWorkItem[]>`
    SELECT "id", "kind", "state", "runId", "claimMode", "fencingToken", "leaseExpiresAt",
           "createdAt", "patchDigest", "baseSha"
    FROM "EngineeringAgentWorkItem"
    WHERE "id" = ${id}
    FOR UPDATE
  `;
  return rows[0] ?? refuse("work_item_not_found");
};

/** A v22 public-write permission is checked again before both issuing and
 * consuming a capability. The code latch defaults closed independently of
 * the older engineering-agent operating mode. */
async function requireV22PublicationAllowed(
  tx: EngineeringAgentTransaction, runId: string | null,
): Promise<void> {
  if (!runId) return;
  const run = await tx.engineeringAgentRun.findUnique({ where: { id: runId },
    select: { cardId: true, card: { select: { sourceSystem: true } } },
  });
  if (run?.card.sourceSystem !== "admin-idea-v4") return;
  if (!amuxV22EngineeringPublicationEnabled(
    process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]) ||
      !(await readAmuxV22PublicPrConsent(run.cardId, tx)))
    refuse("v22_publication_disabled");
}

type LockedCapability = {
  id: string;
  verifierVersion: number;
  policyVersion: number;
  expiresAt: Date;
  consumedAt: Date | null;
  claimFencingToken: bigint | null;
};

/** The item's live capability -- unconsumed and not lapsed -- if it has one. */
const lockLiveCapability = async (
  tx: EngineeringAgentTransaction,
  workItemId: string,
): Promise<LockedCapability | null> => {
  const rows = await tx.$queryRaw<LockedCapability[]>`
    SELECT "id", "verifierVersion", "policyVersion", "expiresAt", "consumedAt", "claimFencingToken"
    FROM "EngineeringAgentCapability"
    WHERE "unconsumedWorkItemId" = ${workItemId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Whether a capability this claim's result may rest on was consumed: by this
 * write claim itself, or -- for a lookup claim -- by an earlier write claim.
 */
const consumedForClaim = async (
  tx: EngineeringAgentTransaction,
  item: LockedWorkItem,
): Promise<boolean> => {
  const rows =
    item.claimMode === "write"
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "EngineeringAgentCapability"
          WHERE "workItemId" = ${item.id} AND "consumedAt" IS NOT NULL AND "claimFencingToken" = ${item.fencingToken}
          FOR UPDATE
        `
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "EngineeringAgentCapability"
          WHERE "workItemId" = ${item.id} AND "consumedAt" IS NOT NULL AND "claimFencingToken" < ${item.fencingToken}
          FOR UPDATE
        `;
  return rows.length > 0;
};

const asWriteKind = (kind: string): WriteItemKind =>
  (WRITE_ITEM_KINDS as readonly string[]).includes(kind) ? (kind as WriteItemKind) : refuse("not_a_write_item");

/** The one state a result leads to, as the core decides it, or a refusal. */
const resultTarget = (kind: WriteItemKind, context: WriteTransitionContext): string => {
  const targets = writeItemStates(kind).filter(
    (to) => decideWriteItemTransition(kind, "claimed", to, context).allowed,
  );
  return targets.length === 1 ? targets[0] : refuse("result_leads_nowhere");
};

export type ClaimInput =
  | { workItemId: string; mode: "lookup"; leaseMs: number }
  | {
      workItemId: string;
      mode: "write";
      leaseMs: number;
      /**
       * What the publisher observed just before claiming a close or a prune.
       * A publish claim has none: its precondition is the capability this
       * claim consumes, here, in the same transaction.
       */
      precondition?: Exclude<WriteClaimPrecondition, { kind: "publish" }>;
    };

/**
 * Claims a write item with the next fencing token and a live lease. A publish
 * write claim consumes the item's capability in the same transaction --
 * unexpired, issued under the current verifier and policy versions -- and a
 * lookup claim consumes nothing.
 */
export async function claimEngineeringAgentWorkItem(
  tx: EngineeringAgentTransaction,
  input: ClaimInput,
): Promise<{ fencingToken: bigint; leaseExpiresAt: Date }> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) refuse("lease_invalid");
  const item = await lockWorkItem(tx, input.workItemId);
  const kind = asWriteKind(item.kind);
  await requireSwitch(tx, input.mode === "write" && kind === "publish" ? "publishAllowed" : "maintenanceAllowed");
  const now = await databaseNow(tx);

  let capability: LockedCapability | null = null;
  let context: WriteTransitionContext;
  if (input.mode === "lookup") {
    context = { event: "claim", mode: "lookup", capabilityConsumed: false };
  } else if (kind === "publish") {
    await requireV22PublicationAllowed(tx, item.runId);
    // A halt stops a write claim here, in the function that spends the
    // capability, and under the lock every halt is written under (§12).
    await lockEngineeringAgentHalt(tx);
    if (engineeringAgentHalted(await readEngineeringAgentHaltState(tx))) refuse("halted");
    capability = await lockLiveCapability(tx, item.id);
    if (!capability) refuse("capability_unavailable");
    if (capability!.expiresAt.getTime() <= now.getTime()) refuse("capability_expired");
    if (capability!.verifierVersion !== ENGINEERING_AGENT_VERIFIER_VERSION) refuse("verifier_changed");
    if (capability!.policyVersion !== ENGINEERING_AGENT_POLICY_VERSION) refuse("policy_changed");
    context = { event: "claim", mode: "write", precondition: { kind: "publish", capabilityConsumed: true } };
  } else {
    if (!input.precondition || input.precondition.kind !== kind) refuse("precondition_missing");
    context = { event: "claim", mode: "write", precondition: input.precondition! };
  }
  const verdict = decideWriteItemTransition(kind, item.state as WriteItemState, "claimed", context);
  if (!verdict.allowed) refuse(verdict.reason);

  const fencingToken = item.fencingToken + BigInt(1);
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  await tx.engineeringAgentWorkItem.update({
    where: { id: item.id },
    data: { state: "claimed", claimMode: input.mode, fencingToken, leaseExpiresAt },
  });
  if (capability) {
    // The trigger writes consumedAt; it accepts only the claim just taken.
    await tx.engineeringAgentCapability.update({
      where: { id: capability.id },
      data: { claimFencingToken: fencingToken },
    });
  }
  await systemAudit(tx, "engineering-agent-publisher", ENGINEERING_AGENT_AUDIT_ACTIONS.workItemClaimed, "engineering_agent_work_item", item.id, {
    kind,
    mode: input.mode,
    fencingToken: fencingToken.toString(),
    capabilityConsumed: capability !== null,
  });
  return { fencingToken, leaseExpiresAt };
}

/** How many lapsed claims one next-work call moves to a lookup. */
export const ENGINEERING_AGENT_LAPSED_CLAIM_SWEEP = 5;

/** Proposed: how long a publisher's claim may run before only a lookup may follow. */
export const ENGINEERING_AGENT_PUBLISH_CLAIM_LEASE_MS = 10 * 60 * 1000;

export type EngineeringAgentPublishWork =
  | {
      mode: "lookup";
      workItemId: string;
      runId: string;
      branch: string;
      fencingToken: bigint;
      leaseExpiresAt: Date;
      /** The capability a write claim consumed; null when none was, and so no write was allowed. */
      consumed: { commitDigest: string; expectedTreeId: string } | null;
    }
  | {
      mode: "write";
      workItemId: string;
      runId: string;
      branch: string;
      fencingToken: bigint;
      leaseExpiresAt: Date;
      cardRef: string;
      baseSha: string;
      patchBody: string;
      patchDigest: string;
      expectedTreeId: string;
      commitDigest: string;
      capabilityExpiresAt: Date;
    };

/**
 * The publisher's next piece of work, claimed. Lookups come first -- a claim
 * whose lease passed, then an outcome nobody knows (§10) -- and a queued item
 * with a live capability only while publishing is allowed. A write claim
 * returns the patch the publisher applies and the capability it must match;
 * a lookup returns only what it needs to look. Nothing to do is `null`.
 */
export async function claimNextEngineeringAgentPublishWork(
  tx: EngineeringAgentTransaction,
  input: { leaseMs: number },
): Promise<EngineeringAgentPublishWork | null> {
  await requireSwitch(tx, "maintenanceAllowed");
  // A claim whose lease passed -- a publisher that died, or an answer that
  // was lost -- goes to a lookup first (§10), so the work is found again.
  const lapsed = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT w."id" FROM "EngineeringAgentWorkItem" w
    WHERE w."kind" = 'publish' AND w."state" = 'claimed' AND w."leaseExpiresAt" <= clock_timestamp() AT TIME ZONE 'UTC'
    ORDER BY w."leaseExpiresAt", w."id"
    LIMIT ${ENGINEERING_AGENT_LAPSED_CLAIM_SWEEP}
    FOR UPDATE SKIP LOCKED
  `;
  for (const row of lapsed) await markEngineeringAgentWorkItemLeaseExpired(tx, { workItemId: row.id });
  const switches = await readEngineeringAgentSwitches(tx);
  // A halt stops claims (§12). A write claim spends its capability, which
  // nothing gives back, so the choice is made under the halt lock; the claim
  // below checks again in the function that spends it. Lookups continue.
  await lockEngineeringAgentHalt(tx);
  const publishAllowed = switches.publishAllowed && !engineeringAgentHalted(await readEngineeringAgentHaltState(tx));
  const v22PublicationEnabled = amuxV22EngineeringPublicationEnabled(
    process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]);
  const now = await databaseNow(tx);
  const candidates = await tx.$queryRaw<Array<{ id: string; state: string }>>`
    SELECT w."id", w."state"
    FROM "EngineeringAgentWorkItem" w
    WHERE w."kind" = 'publish'
      AND (
        w."state" IN ('needs_lookup', 'outcome_unknown')
        OR (
          ${publishAllowed} AND w."state" = 'queued'
          AND (${v22PublicationEnabled} OR NOT EXISTS (
            SELECT 1 FROM "EngineeringAgentRun" r
            JOIN "AmuxWorkItem" card ON card."id" = r."cardId"
            WHERE r."id" = w."runId"
              AND card."sourceSystem" = 'admin-idea-v4'
          ))
          AND EXISTS (
            SELECT 1 FROM "EngineeringAgentCapability" c
            WHERE c."unconsumedWorkItemId" = w."id" AND c."expiresAt" > ${now}
          )
        )
      )
    ORDER BY CASE w."state" WHEN 'needs_lookup' THEN 0 WHEN 'outcome_unknown' THEN 1 ELSE 2 END, w."createdAt", w."id"
    LIMIT 1
    FOR UPDATE OF w SKIP LOCKED
  `;
  const candidate = candidates[0];
  if (!candidate) return null;
  const mode = candidate.state === "queued" ? "write" : "lookup";
  const claim = await claimEngineeringAgentWorkItem(tx, { workItemId: candidate.id, mode, leaseMs: input.leaseMs });
  const item = await tx.engineeringAgentWorkItem.findUniqueOrThrow({
    where: { id: candidate.id },
    select: {
      runId: true,
      patchBody: true,
      patchDigest: true,
      baseSha: true,
      expectedTreeId: true,
      run: { select: { cardId: true } },
    },
  });
  const runId = item.runId ?? refuse("publish_item_without_run");
  const common = {
    workItemId: candidate.id,
    runId,
    branch: engineeringBranchName(runId),
    fencingToken: claim.fencingToken,
    leaseExpiresAt: claim.leaseExpiresAt,
  };
  if (mode === "lookup") {
    // What a lookup compares a found commit with: the capability a write
    // claim consumed, if any did. None consumed means no write was allowed,
    // so anything found under the branch is not this item's (§10).
    const consumed = await tx.engineeringAgentCapability.findFirst({
      where: { workItemId: candidate.id, consumedAt: { not: null } },
      orderBy: { consumedAt: "desc" },
      select: { commitDigest: true, expectedTreeId: true },
    });
    return { mode, ...common, consumed };
  }
  const capability = await tx.engineeringAgentCapability.findFirstOrThrow({
    where: { workItemId: candidate.id, claimFencingToken: claim.fencingToken },
    select: { commitDigest: true, expiresAt: true },
  });
  return {
    mode,
    ...common,
    cardRef: item.run?.cardId ?? refuse("publish_item_without_run"),
    baseSha: item.baseSha ?? refuse("publish_item_without_base"),
    patchBody: item.patchBody ?? refuse("publish_item_without_patch"),
    patchDigest: item.patchDigest ?? refuse("publish_item_without_patch"),
    expectedTreeId: item.expectedTreeId ?? refuse("publish_item_without_tree"),
    commitDigest: capability.commitDigest,
    capabilityExpiresAt: capability.expiresAt,
  };
}

/**
 * Records a claim's result. The target state is the core's answer to the
 * outcome, the claim mode and whether the item's capability is consumed; a
 * stale fencing token decides nothing. An unknown outcome opens its decision
 * item in the same transaction (§10).
 */
export async function settleEngineeringAgentWorkItem(
  tx: EngineeringAgentTransaction,
  input: { workItemId: string; fencingToken: bigint; outcome: WriteResultOutcome; reason?: string },
): Promise<{ state: string; decisionItemId: string | null }> {
  if (input.reason !== undefined && !REASON.test(input.reason)) refuse("reason_invalid");
  const item = await lockWorkItem(tx, input.workItemId);
  const kind = asWriteKind(item.kind);
  if (item.state !== "claimed" || item.claimMode === null) refuse("work_item_not_claimed");
  const capabilityConsumed = kind === "publish" ? await consumedForClaim(tx, item) : false;
  const to = resultTarget(kind, {
    event: "result",
    claimMode: item.claimMode as WriteClaimMode,
    fencingMatches: item.fencingToken === input.fencingToken,
    outcome: input.outcome,
    capabilityConsumed,
  });
  await tx.engineeringAgentWorkItem.update({
    where: { id: item.id },
    data: { state: to, ...(input.reason !== undefined ? { reason: input.reason } : {}) },
  });
  let decisionItemId: string | null = null;
  if (to === "outcome_unknown") {
    const decision = await tx.engineeringAgentWorkItem.create({
      data: {
        id: randomUUID(),
        kind: "decision",
        state: "open",
        causeKey: unknownOutcomeDecisionCauseKey(item.id, item.fencingToken),
        runId: item.runId,
        reason: "outcome_unknown",
      },
      select: { id: true },
    });
    decisionItemId = decision.id;
  }
  await systemAudit(tx, "engineering-agent-publisher", ENGINEERING_AGENT_AUDIT_ACTIONS.workItemSettled, "engineering_agent_work_item", item.id, {
    kind,
    outcome: input.outcome,
    state: to,
    fencingToken: input.fencingToken.toString(),
    decisionItemId,
  });
  return { state: to, decisionItemId };
}

/** A claim whose lease has passed goes to `needs_lookup`, and nowhere else. */
export async function markEngineeringAgentWorkItemLeaseExpired(
  tx: EngineeringAgentTransaction,
  input: { workItemId: string },
): Promise<void> {
  const item = await lockWorkItem(tx, input.workItemId);
  const kind = asWriteKind(item.kind);
  await requireSwitch(tx, "maintenanceAllowed");
  const now = await databaseNow(tx);
  if (item.state !== "claimed" || !item.leaseExpiresAt || item.leaseExpiresAt.getTime() > now.getTime()) {
    refuse("lease_not_expired");
  }
  const verdict = decideWriteItemTransition(kind, "claimed", "needs_lookup", { event: "lease_expired" });
  if (!verdict.allowed) refuse(verdict.reason);
  await tx.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "needs_lookup" } });
  await systemAudit(tx, "engineering-agent-observer", ENGINEERING_AGENT_AUDIT_ACTIONS.workItemLeaseExpired, "engineering_agent_work_item", item.id, {
    kind,
    fencingToken: item.fencingToken.toString(),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The queue's expiry (§12): an unclaimed publish item after the PR queue's
 * period, an undecided draft or decision after the decision queue's. A draft
 * that has a decision never merely expires (the trigger's rule).
 */
export async function expireEngineeringAgentWorkItem(
  tx: EngineeringAgentTransaction,
  input: { workItemId: string },
): Promise<void> {
  const item = await lockWorkItem(tx, input.workItemId);
  await requireSwitch(tx, "maintenanceAllowed");
  const now = await databaseNow(tx);
  const ttlDays =
    item.kind === "publish" && item.state === "queued"
      ? QUEUE_TTL_DAYS.pr
      : (item.kind === "t2_draft" || item.kind === "decision") && item.state === "open"
        ? QUEUE_TTL_DAYS.decision
        : refuse("work_item_does_not_expire");
  if (now.getTime() - item.createdAt.getTime() < ttlDays * DAY_MS) refuse("work_item_not_due");
  await tx.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "expired" } });
  await systemAudit(tx, "engineering-agent-retention", ENGINEERING_AGENT_AUDIT_ACTIONS.workItemExpired, "engineering_agent_work_item", item.id, {
    kind: item.kind,
  });
}

/* ------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Issues a queued publish item's live capability, at the database's time,
 * under the current verifier and policy versions. A live one that has expired
 * lapses first; a live one that has not is a refusal. The commit fields are
 * bound by digest: whoever later claims must reproduce the same commit object.
 */
export async function issueEngineeringAgentCapability(
  tx: EngineeringAgentTransaction,
  input: { workItemId: string; capability: Omit<IssueInput, "now" | "verifierVersion" | "policyVersion"> },
): Promise<{ capabilityId: string; commitDigest: string; expiresAt: Date }> {
  const item = await lockWorkItem(tx, input.workItemId);
  if (item.kind !== "publish" || item.state !== "queued") refuse("work_item_not_a_queued_publish");
  await requireV22PublicationAllowed(tx, item.runId);
  if (item.patchDigest !== input.capability.patchDigest || item.baseSha !== input.capability.baseSha) {
    refuse("capability_does_not_match_item");
  }
  if (item.runId !== input.capability.commit.runId) refuse("capability_run_mismatch");
  await requireSwitch(tx, "publishAllowed");
  const now = await databaseNow(tx);
  const live = await lockLiveCapability(tx, item.id);
  if (live) {
    if (live.expiresAt.getTime() > now.getTime()) refuse("capability_already_live");
    // The trigger allows a lapse only after expiry, and a lapsed one is never consumed.
    await tx.engineeringAgentCapability.update({ where: { id: live.id }, data: { unconsumedWorkItemId: null } });
  }
  const capability = issueCapability({
    ...input.capability,
    verifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION,
    policyVersion: ENGINEERING_AGENT_POLICY_VERSION,
    now,
  });
  const commitDigest = sha256Hex(capabilityCommitObject(capability));
  const created = await tx.engineeringAgentCapability.create({
    data: {
      id: randomUUID(),
      workItemId: item.id,
      baseSha: capability.baseSha,
      patchDigest: capability.patchDigest,
      expectedTreeId: capability.expectedTreeId,
      verifierVersion: capability.verifierVersion,
      policyVersion: capability.policyVersion,
      branch: capability.branch,
      commitDigest,
      expiresAt: capability.expiresAt,
    },
    select: { id: true, expiresAt: true },
  });
  await systemAudit(tx, "engineering-agent-runner", ENGINEERING_AGENT_AUDIT_ACTIONS.capabilityIssued, "engineering_agent_work_item", item.id, {
    capabilityId: created.id,
    patchDigest: capability.patchDigest,
    expectedTreeId: capability.expectedTreeId,
    commitDigest,
  });
  return { capabilityId: created.id, commitDigest, expiresAt: created.expiresAt };
}

/* ------------------------------------------------------------------------- */
/* Owner decisions (a person's actions)                                       */
/* ------------------------------------------------------------------------- */

/**
 * A T2 decision (§7): the audit entry, the decision row bound to the digest
 * and base the owner saw, and the draft closed as decided -- one transaction.
 * The route has already checked the permission and the step-up.
 */
export async function decideEngineeringAgentT2Draft(
  tx: EngineeringAgentTransaction,
  input: {
    session: Session;
    request?: Request;
    workItemId: string;
    decision: "approved" | "rejected";
    patchDigest: string;
    baseSha: string;
  },
): Promise<{ approvalId: string; auditLogId: string }> {
  const actorUserId = humanActorId(input.session);
  const item = await lockWorkItem(tx, input.workItemId);
  if (item.kind !== "t2_draft" || item.state !== "open") refuse("draft_not_open");
  if (item.patchDigest !== input.patchDigest || item.baseSha !== input.baseSha) refuse("draft_changed");
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: ENGINEERING_AGENT_AUDIT_ACTIONS.t2Decided,
    targetType: "engineering_agent_work_item",
    targetId: item.id,
    summary: `${ENGINEERING_AGENT_AUDIT_ACTIONS.t2Decided} ${item.id}`,
    metadata: { decision: input.decision, patchDigest: input.patchDigest, baseSha: input.baseSha },
    tx,
  });
  const approval = await tx.engineeringAgentApproval.create({
    data: {
      id: randomUUID(),
      workItemId: item.id,
      decision: input.decision,
      patchDigest: input.patchDigest,
      baseSha: input.baseSha,
      actorUserId,
      auditLogId,
    },
    select: { id: true },
  });
  await tx.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: input.decision } });
  return { approvalId: approval.id, auditLogId };
}

/** A person has seen a decision item. The route has checked permission and step-up. */
export async function acknowledgeEngineeringAgentDecision(
  tx: EngineeringAgentTransaction,
  input: { session: Session; request?: Request; workItemId: string },
): Promise<{ auditLogId: string }> {
  humanActorId(input.session);
  const item = await lockWorkItem(tx, input.workItemId);
  if (item.kind !== "decision" || item.state !== "open") refuse("decision_not_open");
  await tx.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "acknowledged" } });
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: ENGINEERING_AGENT_AUDIT_ACTIONS.decisionAcknowledged,
    targetType: "engineering_agent_work_item",
    targetId: item.id,
    summary: `${ENGINEERING_AGENT_AUDIT_ACTIONS.decisionAcknowledged} ${item.id}`,
    metadata: { kind: "decision" },
    tx,
  });
  return { auditLogId };
}

/* ------------------------------------------------------------------------- */
/* State mismatches (§11)                                                     */
/* ------------------------------------------------------------------------- */

/** The actions the console offers. `retry_lookup` is the publisher's next round, not a button. */
export const ENGINEERING_AGENT_MISMATCH_CONSOLE_ACTIONS = [
  "close_domain_after_verified_no_write",
  "leave_open",
  "mode_off",
  "escalate_incident",
] as const satisfies readonly MismatchAction[];

/** The run a mismatch item concerns: its own, or its publish item's. */
async function mismatchRunId(
  db: Pick<Prisma.TransactionClient, "engineeringAgentWorkItem">,
  item: { causeKey: string; runId: string | null },
): Promise<string | null> {
  if (item.causeKey.startsWith("run_attempt:")) return item.runId;
  if (item.causeKey.startsWith("review_pr:")) {
    const publish = await db.engineeringAgentWorkItem.findUnique({
      where: { id: item.causeKey.slice("review_pr:".length) },
      select: { runId: true },
    });
    return publish?.runId ?? null;
  }
  return null;
}

/**
 * The AMUX rows a mismatch concerns -- its run's attempt, its card, then its
 * delivery, in AMUX's own order -- locked before the audit chain (§11). Passed to
 * runEngineeringAgentTransaction as `beforeAuditLock`; it writes nothing.
 */
export async function lockEngineeringAgentMismatchAmuxRows(
  tx: Prisma.TransactionClient,
  workItemId: string,
): Promise<void> {
  const item = await tx.engineeringAgentWorkItem.findUnique({
    where: { id: workItemId },
    select: { causeKey: true, runId: true },
  });
  if (!item) return;
  const runId = await mismatchRunId(tx, item);
  if (runId === null) return;
  const run = await tx.engineeringAgentRun.findUnique({ where: { id: runId }, select: { amuxAttemptId: true, cardId: true } });
  if (!run) return;
  await tx.$queryRaw`SELECT "id" FROM "AmuxExecutionAttempt" WHERE "id" = ${run.amuxAttemptId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${run.cardId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "attemptId" FROM "AmuxWorkDelivery" WHERE "attemptId" = ${run.amuxAttemptId} FOR UPDATE`;
}

/**
 * A person's action on a state mismatch (§11). The item and both sides are
 * read again under their locks; the pure table decides whether the action may
 * run and whether it closes the item. Neither side is corrected to match the
 * other: closing the domain side ends the run as abandoned only when nothing
 * of it was ever allowed to write to GitHub, and escalation turns the agent off
 * and leaves the rest to the incident.
 */
export async function resolveEngineeringAgentStateMismatch(
  tx: EngineeringAgentTransaction,
  input: { session: Session; request?: Request; workItemId: string; action: MismatchAction },
): Promise<{ auditLogId: string; resolved: boolean }> {
  humanActorId(input.session);
  if (!(ENGINEERING_AGENT_MISMATCH_CONSOLE_ACTIONS as readonly string[]).includes(input.action)) {
    refuse("mismatch_action_not_offered");
  }
  // The cause and run never change on an item, so they are read before any
  // engineering lock; the run is then locked before the work item, in the
  // cross lock order (run, work item, capability, binding).
  const item =
    (await tx.engineeringAgentWorkItem.findUnique({
      where: { id: input.workItemId },
      select: { causeKey: true, runId: true },
    })) ?? refuse("work_item_not_found");
  const lockedRunId = await mismatchRunId(tx, item);
  if (lockedRunId !== null) {
    await tx.$queryRaw`SELECT "id" FROM "EngineeringAgentRun" WHERE "id" = ${lockedRunId} FOR UPDATE`;
  }
  const locked = await lockWorkItem(tx, input.workItemId);
  if (locked.kind !== "state_mismatch" || locked.state !== "open") refuse("mismatch_not_open");
  const kind: "A" | "C" = item.causeKey.startsWith("run_attempt:")
    ? "A"
    : item.causeKey.startsWith("review_pr:")
      ? "C"
      : refuse("mismatch_cause_unknown");
  const runId = (await mismatchRunId(tx, item)) ?? refuse("mismatch_without_run");
  const run = await tx.engineeringAgentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { id: true, status: true, amuxAttemptId: true },
  });
  // The same locks the transaction took first; held already, so no wait.
  const attempts = await tx.$queryRaw<Array<{ endedAt: Date | null }>>`
    SELECT "endedAt" FROM "AmuxExecutionAttempt" WHERE "id" = ${run.amuxAttemptId} FOR UPDATE
  `;
  const attemptEnded = attempts[0]?.endedAt != null;
  const runItems = await tx.engineeringAgentWorkItem.findMany({
    where: { runId: run.id, kind: { in: ["publish", "t2_draft"] } },
    select: { id: true, kind: true, state: true },
  });
  const publishItem =
    kind === "C" ? runItems.find((candidate) => candidate.id === item.causeKey.slice("review_pr:".length)) ?? null : null;
  const consumed = await tx.engineeringAgentCapability.count({
    where: { consumedAt: { not: null }, workItem: { runId: run.id } },
  });
  const verdict = decideMismatchAction({
    kind,
    action: input.action,
    // Detection's reading: A is an ended attempt under an active run; C is a
    // published item whose run has ended.
    reReadMatchesDetection:
      kind === "A" ? attemptEnded && run.status === "active" : publishItem?.state === "published" && run.status !== "active",
    runActive: run.status === "active",
    runTerminal: run.status !== "active",
    workItemState: kind === "A" ? (runItems.find((candidate) => candidate.kind === "publish")?.state ?? null) : (publishItem?.state ?? null),
    workItemTerminal: publishItem?.state === "published",
    lookupVerifiedNoWrite: consumed === 0,
    // One item per cause (its key is unique), so a cause cannot recur here.
    recurrences: 0,
  });
  if (!verdict.allowed) return refuse(verdict.reason);

  if (input.action === "close_domain_after_verified_no_write") {
    // Nothing of the run may still be waiting to be written or decided.
    if (runItems.some((candidate) => candidate.state === "queued" || candidate.state === "claimed" || candidate.state === "open")) {
      refuse("run_has_open_work");
    }
    await lockEngineeringAgentHalt(tx);
    const moved = await tx.engineeringAgentRun.updateMany({
      where: { id: run.id, status: "active" },
      data: { status: "abandoned", outcome: "abandoned", halt: "none" },
    });
    if (moved.count !== 1) refuse("run_not_active");
  }
  if (input.action === "mode_off" || input.action === "escalate_incident") {
    await setEngineeringAgentSwitch(tx, { session: input.session, request: input.request, name: "mode", value: "off" });
  }
  if (verdict.resolves) {
    await tx.engineeringAgentWorkItem.update({ where: { id: locked.id }, data: { state: "resolved" } });
  }
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: ENGINEERING_AGENT_AUDIT_ACTIONS.mismatchActed,
    targetType: "engineering_agent_work_item",
    targetId: locked.id,
    summary: `${ENGINEERING_AGENT_AUDIT_ACTIONS.mismatchActed} ${locked.id}`,
    metadata: { kind, action: input.action, resolved: verdict.resolves, runId: run.id },
    tx,
  });
  return { auditLogId, resolved: verdict.resolves };
}

/** The modes a person may set from the console. */
export const ENGINEERING_AGENT_CONSOLE_MODES = ["off", "shadow"] as const;

/**
 * A person sets the mode or the freeze (§11), with the audit entry in the
 * same transaction. `t1` is not settable here: publishing waits on the
 * person-only approval evidence the policy requires before t1 (§9-10, §14),
 * and a console button would be that procedure's last step offered without
 * the rest. Turning the agent off or freezing it is always allowed -- stopping
 * should be easy.
 */
export async function setEngineeringAgentSwitch(
  tx: EngineeringAgentTransaction,
  input: { session: Session; request?: Request; name: "mode" | "freeze"; value: string },
): Promise<{ auditLogId: string }> {
  humanActorId(input.session);
  if (input.name === "mode" && !(ENGINEERING_AGENT_CONSOLE_MODES as readonly string[]).includes(input.value)) {
    refuse("mode_not_settable_here");
  }
  if (input.name === "freeze" && input.value !== "true" && input.value !== "false") refuse("freeze_value_invalid");
  const key = input.name === "mode" ? ENGINEERING_AGENT_MODE_SETTING_KEY : ENGINEERING_AGENT_FREEZE_SETTING_KEY;
  const previous = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
  // Turning the mode on from `off` passes the armed gate (§12). Turning it
  // off, and freezing, never do.
  if (input.name === "mode" && input.value !== "off" && parseEngineeringAgentMode(previous?.value) === "off") {
    const readings = await tx.appSetting.findMany({
      where: {
        key: {
          in: [
            ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY,
            ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY,
            ENGINEERING_AGENT_MONITORS_CONFIRMED_SETTING_KEY,
          ],
        },
      },
      select: { key: true, value: true },
    });
    const at = (settingKey: string) => parseSettingInstant(readings.find((row) => row.key === settingKey)?.value);
    const gate = decideArmedGate({
      runnerLastFinishAt: at(ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY),
      publisherLastFinishAt: at(ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY),
      monitorsConfirmedAt: at(ENGINEERING_AGENT_MONITORS_CONFIRMED_SETTING_KEY),
      now: await databaseNow(tx),
    });
    if (!gate.armed) refuse(`armed_gate_${gate.missing.join("_")}`);
  }
  await tx.appSetting.upsert({ where: { key }, update: { value: input.value }, create: { key, value: input.value } });
  const known = (value: string | undefined) =>
    value === undefined ? null : ["off", "shadow", "t1", "true", "false"].includes(value) ? value : "unrecognised";
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: ENGINEERING_AGENT_AUDIT_ACTIONS.switchChanged,
    targetType: "AppSetting",
    targetId: key,
    summary: `${ENGINEERING_AGENT_AUDIT_ACTIONS.switchChanged} ${input.name}`,
    metadata: { name: input.name, from: known(previous?.value), to: input.value },
    tx,
  });
  return { auditLogId };
}

/* ------------------------------------------------------------------------- */
/* Acknowledgements and records a person or a service makes                   */
/* ------------------------------------------------------------------------- */

const writeInstant = async (tx: EngineeringAgentTransaction, key: string): Promise<Date> => {
  const now = await databaseNow(tx);
  await tx.appSetting.upsert({
    where: { key },
    update: { value: now.toISOString() },
    create: { key, value: now.toISOString() },
  });
  return now;
};

/**
 * A person clears the halts only a person clears (§12): a halt a run recorded
 * and a latched circuit, from this instant on. It does not resolve an open
 * state mismatch or a run whose attempt ended -- those stay until their own
 * cause is dealt with -- and it says in its audit entry what it cleared.
 */
export async function acknowledgeEngineeringAgentHalt(
  tx: EngineeringAgentTransaction,
  input: { session: Session; request?: Request },
): Promise<{ auditLogId: string; acknowledgedAt: Date }> {
  humanActorId(input.session);
  await lockEngineeringAgentHalt(tx);
  const before = await readEngineeringAgentHaltState(tx);
  const acknowledgedAt = await writeInstant(tx, ENGINEERING_AGENT_HALT_ACKNOWLEDGED_SETTING_KEY);
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: ENGINEERING_AGENT_AUDIT_ACTIONS.haltAcknowledged,
    targetType: "AppSetting",
    targetId: ENGINEERING_AGENT_HALT_ACKNOWLEDGED_SETTING_KEY,
    summary: ENGINEERING_AGENT_AUDIT_ACTIONS.haltAcknowledged,
    metadata: {
      unacknowledgedHalt: before.unacknowledgedHalt,
      circuitLatched: before.circuitLatched,
      openStateMismatches: before.openStateMismatches,
      orphanedRuns: before.orphanedRuns,
    },
    tx,
  });
  return { auditLogId, acknowledgedAt };
}

/**
 * The operator's record that both dead-man monitors are active and their
 * alerts reach someone, confirmed on the monitors' own screen (§12, the armed
 * gate). The app cannot see the monitors; this is a person's statement, made
 * under their name.
 */
export async function recordEngineeringAgentMonitorsConfirmed(
  tx: EngineeringAgentTransaction,
  input: { session: Session; request?: Request },
): Promise<{ auditLogId: string; confirmedAt: Date }> {
  humanActorId(input.session);
  const confirmedAt = await writeInstant(tx, ENGINEERING_AGENT_MONITORS_CONFIRMED_SETTING_KEY);
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: ENGINEERING_AGENT_AUDIT_ACTIONS.monitorsConfirmed,
    targetType: "AppSetting",
    targetId: ENGINEERING_AGENT_MONITORS_CONFIRMED_SETTING_KEY,
    summary: ENGINEERING_AGENT_AUDIT_ACTIONS.monitorsConfirmed,
    metadata: {},
    tx,
  });
  return { auditLogId, confirmedAt };
}

/**
 * A service's report that a cycle ran to its end (§12, the armed gate). It is
 * the service speaking about itself -- an indicator, not evidence -- and it is
 * recorded whatever the switches say, as a cycle in mode `off` still runs.
 */
export async function recordEngineeringAgentServiceFinish(
  tx: EngineeringAgentTransaction,
  input: { service: "runner" | "publisher" },
): Promise<{ finishedAt: Date }> {
  const key =
    input.service === "runner"
      ? ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY
      : ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY;
  const finishedAt = await writeInstant(tx, key);
  await systemAudit(
    tx,
    input.service === "runner" ? "engineering-agent-runner" : "engineering-agent-publisher",
    ENGINEERING_AGENT_AUDIT_ACTIONS.serviceFinished,
    "app_setting",
    key,
    { service: input.service },
  );
  return { finishedAt };
}

/**
 * The runner saw a branch or pull request under the agent's namespace that
 * nothing the agent did accounts for (§12). Recorded with the database's
 * clock; it halts until a person acknowledges it, and is never refused by a
 * switch -- it is a reading, not an action.
 */
export async function recordEngineeringAgentObservedHalt(
  tx: EngineeringAgentTransaction,
  input: { halt: ObservableHalt },
): Promise<{ observedAt: Date }> {
  if (!(OBSERVABLE_HALTS as readonly string[]).includes(input.halt)) refuse("halt_not_observable");
  await lockEngineeringAgentHalt(tx);
  const observedAt = await databaseNow(tx);
  const value = JSON.stringify({ halt: input.halt, at: observedAt.toISOString() });
  await tx.appSetting.upsert({
    where: { key: ENGINEERING_AGENT_OBSERVED_HALT_SETTING_KEY },
    update: { value },
    create: { key: ENGINEERING_AGENT_OBSERVED_HALT_SETTING_KEY, value },
  });
  await systemAudit(
    tx,
    "engineering-agent-runner",
    ENGINEERING_AGENT_AUDIT_ACTIONS.haltObserved,
    "app_setting",
    ENGINEERING_AGENT_OBSERVED_HALT_SETTING_KEY,
    { halt: input.halt },
  );
  return { observedAt };
}

/* ------------------------------------------------------------------------- */
/* Bindings                                                                   */
/* ------------------------------------------------------------------------- */

const isoInstant = z.string().datetime({ offset: false });
const sha1 = z.string().regex(SHA1);
const sha256 = z.string().regex(SHA256);
const reviewId = z.number().int().positive();

/**
 * What the app bound a pull request to (§9-10 conditions 2, 6 and 7): the base
 * and diff it verified, the tree it judged, and the reviews a re-bind made
 * invalid. No person identifier.
 */
export const engineeringAgentBindingSnapshotSchema = z
  .object({
    baseSha: sha1,
    diffDigest: sha256,
    treeId: sha1,
    invalidatedReviewIds: z.array(reviewId).max(100),
  })
  .strict();


/**
 * The approval verdict, recorded once, before merge (§9-10). An undetermined
 * reading is not recorded -- it is read again next round. The reviewer's
 * identity is not here: it goes to the binding's reviewer columns, which
 * retention may clear.
 */
export const engineeringAgentApprovalObservationSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      verdict: z.literal("approved"),
      reviewId,
      reviewCommitId: sha1,
      submittedAt: isoInstant,
      observedAt: isoInstant,
    })
    .strict(),
  z
    .object({
      verdict: z.literal("not_approved"),
      reason: z.enum(ENGINEERING_AGENT_NOT_APPROVED_REASONS),
      observedAt: isoInstant,
    })
    .strict(),
]);

/** Whether and how the pull request was merged. The merger is a kind, never an identity. */
export const engineeringAgentMergeObservationSchema = z
  .object({
    merged: z.boolean(),
    mergeCommitSha: sha1.nullable(),
    mergedAt: isoInstant.nullable(),
    mergedByKind: z.enum(ENGINEERING_AGENT_MERGER_KINDS),
    observedAt: isoInstant,
  })
  .strict()
  .refine((value) => value.merged === (value.mergeCommitSha !== null && value.mergedAt !== null), {
    message: "a merge has a commit and a time, and only a merge does",
  });

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

type LockedBinding = { id: string; runId: string; prNumber: number; state: string; supersededAt: Date | null };

const lockBinding = async (tx: EngineeringAgentTransaction, id: string): Promise<LockedBinding> => {
  const rows = await tx.$queryRaw<LockedBinding[]>`
    SELECT "id", "runId", "prNumber", "state", "supersededAt"
    FROM "EngineeringAgentBinding"
    WHERE "id" = ${id}
    FOR UPDATE
  `;
  return rows[0] ?? refuse("binding_not_found");
};

export type BindingInput = {
  runId: string;
  prNumber: number;
  headSha: string;
  verifiedHeadSha: string;
  snapshot: z.infer<typeof engineeringAgentBindingSnapshotSchema>;
};

const bindingData = (input: BindingInput) => {
  if (!isRunId(input.runId)) refuse("run_id_invalid");
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) refuse("pr_number_invalid");
  if (!SHA1.test(input.headSha) || !SHA1.test(input.verifiedHeadSha)) refuse("head_sha_invalid");
  const snapshot = engineeringAgentBindingSnapshotSchema.safeParse(input.snapshot);
  if (!snapshot.success) refuse("snapshot_invalid");
  return {
    id: randomUUID(),
    runId: input.runId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    verifiedHeadSha: input.verifiedHeadSha,
    ref: engineeringBranchName(input.runId),
    snapshot: snapshot.data as Prisma.InputJsonObject,
  };
};

/** Binds a pull request the publisher opened. */
export async function recordEngineeringAgentBinding(
  tx: EngineeringAgentTransaction,
  input: BindingInput,
): Promise<{ bindingId: string }> {
  const created = await tx.engineeringAgentBinding.create({ data: bindingData(input), select: { id: true } });
  await systemAudit(tx, "engineering-agent-publisher", ENGINEERING_AGENT_AUDIT_ACTIONS.bindingRecorded, "engineering_agent_binding", created.id, {
    runId: input.runId,
    prNumber: input.prNumber,
    headSha: input.headSha,
  });
  return { bindingId: created.id };
}

/* ------------------------------------------------------------------------- */
/* Registrations (§2.2)                                                       */
/* ------------------------------------------------------------------------- */

export type RegistrationRecordInput = {
  id: string;
  source: "S1" | "S2" | "S3";
  pinnedCommit: string;
  itemKey: string;
  itemDigest: string;
  proposalDigest: string;
  guardResult: string;
  roundId: string;
  /** `registered` names its AMUX card; a refusal names none. */
  result: "registered" | "registration_refused";
  amuxCardId: string | null;
};

/** The cap counts, as the registration trigger counts them (§2.2). */
export async function readEngineeringAgentRegistrationCounts(
  db: Pick<EngineeringAgentTransaction, "$queryRaw">,
  roundId: string,
): Promise<{ thisRound: number; todayUtc: number; unpromoted: number }> {
  const rows = await db.$queryRaw<Array<{ thisRound: bigint; todayUtc: bigint; unpromoted: bigint }>>`
    SELECT
      (SELECT count(*) FROM "EngineeringAgentRegistration" r
        WHERE r."roundId" = ${roundId} AND r."result" NOT IN ('registration_refused', 'absent')) AS "thisRound",
      (SELECT count(*) FROM "EngineeringAgentRegistration" r
        WHERE r."createdAt" >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
          AND r."result" NOT IN ('registration_refused', 'absent')) AS "todayUtc",
      (SELECT count(*) FROM "EngineeringAgentRegistration" r
        LEFT JOIN "AmuxWorkItem" c ON c."id" = r."amuxCardId"
        WHERE r."result" IN ('pending', 'partial')
           OR (r."result" = 'registered' AND c."status" = 'backlog' AND c."archivedAt" IS NULL)) AS "unpromoted"
  `;
  const row = rows[0];
  return { thisRound: Number(row.thisRound), todayUtc: Number(row.todayUtc), unpromoted: Number(row.unpromoted) };
}

/** A registration a proposal cannot add to: the row its item already has at this digest. */
export type ExistingRegistration = { id: string; result: string; amuxCardId: string | null };

/**
 * The registration lock -- the one the insert trigger counts the caps under --
 * then the item's row at this digest, then the caps. Under the lock the
 * answer is the one the insert would meet, so an item already recorded is
 * found, not a unique violation, and a full cap is the refusal it names, not
 * a trigger's exception. The trigger still counts: this only makes the
 * refusal definite and named.
 */
async function lockRegistrationItem(
  tx: EngineeringAgentTransaction,
  input: { source: string; itemKey: string; itemDigest: string; roundId: string },
): Promise<ExistingRegistration | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('engineering-agent:registration'))`;
  const existing = await tx.engineeringAgentRegistration.findUnique({
    where: {
      source_itemKey_itemDigest: { source: input.source, itemKey: input.itemKey, itemDigest: input.itemDigest },
    },
    select: { id: true, result: true, amuxCardId: true },
  });
  if (existing !== null) return existing;
  const counts = await readEngineeringAgentRegistrationCounts(tx, input.roundId);
  if (counts.thisRound >= REGISTRATION_CAPS.perRound) refuse("round_cap_reached");
  if (counts.todayUtc >= REGISTRATION_CAPS.perUtcDay) refuse("daily_cap_reached");
  if (counts.unpromoted >= REGISTRATION_CAPS.unpromoted) refuse("unpromoted_cap_reached");
  return null;
}

/** The refusals `lockRegistrationItem` names for a full cap. */
export const ENGINEERING_AGENT_REGISTRATION_CAP_REFUSALS: ReadonlySet<string> = new Set([
  "round_cap_reached",
  "daily_cap_reached",
  "unpromoted_cap_reached",
]);

/**
 * Records a registration proposal and what became of it, once (§2.2, §11):
 * the source, the pinned revision, the digests and the guard's result, never
 * the proposal's text. The row is inserted `pending` -- the database counts
 * the caps there -- and moves to its result in the same transaction. A
 * registered row is written in the AMUX agent intake's transaction, beside
 * its card. Registration stops while anything halts (§12).
 *
 * An item that already has a row at this digest is not written again: the
 * row is returned, and the caller decides whether it is this proposal's own
 * earlier answer or a refusal. A full cap is refused by name.
 */
export async function recordEngineeringAgentRegistration(
  tx: EngineeringAgentTransaction,
  input: RegistrationRecordInput,
): Promise<{ recorded: true; registrationId: string } | { recorded: false; existing: ExistingRegistration }> {
  await requireSwitch(tx, "registrationAllowed");
  await lockEngineeringAgentHalt(tx);
  if (engineeringAgentHalted(await readEngineeringAgentHaltState(tx))) refuse("halted");
  if ((input.result === "registered") !== (input.amuxCardId !== null)) refuse("registration_card_mismatch");
  const existing = await lockRegistrationItem(tx, input);
  if (existing !== null) return { recorded: false, existing };
  await tx.engineeringAgentRegistration.create({
    data: {
      id: input.id,
      source: input.source,
      pinnedCommit: input.pinnedCommit,
      itemKey: input.itemKey,
      itemDigest: input.itemDigest,
      proposalDigest: input.proposalDigest,
      guardResult: input.guardResult,
      roundId: input.roundId,
    },
  });
  await tx.engineeringAgentRegistration.update({
    where: { id: input.id },
    data: { result: input.result, amuxCardId: input.amuxCardId },
  });
  await systemAudit(
    tx,
    "engineering-agent-registrar",
    ENGINEERING_AGENT_AUDIT_ACTIONS.registrationRecorded,
    "engineering_agent_registration",
    input.id,
    {
      source: input.source,
      itemDigest: input.itemDigest,
      proposalDigest: input.proposalDigest,
      guardResult: input.guardResult,
      result: input.result,
      amuxCardId: input.amuxCardId,
    },
  );
  return { recorded: true, registrationId: input.id };
}

/**
 * What the read-back found after an AMUX intake commit whose answer was lost
 * (AMUX intake version 2): nothing written is `absent`; a card without this
 * agent's record is `partial`, which opens a decision for a person. Nothing
 * is retried. A proposal is recorded here only when its own row was not.
 */
export async function recordEngineeringAgentRegistrationReadBack(
  tx: EngineeringAgentTransaction,
  input: Omit<RegistrationRecordInput, "result" | "amuxCardId"> & { found: "absent" | "partial" },
): Promise<
  { recorded: true; registrationId: string; decisionItemId: string | null } | { recorded: false; existing: ExistingRegistration }
> {
  await lockEngineeringAgentHalt(tx);
  const existing = await lockRegistrationItem(tx, input);
  if (existing !== null) return { recorded: false, existing };
  await tx.engineeringAgentRegistration.create({
    data: {
      id: input.id,
      source: input.source,
      pinnedCommit: input.pinnedCommit,
      itemKey: input.itemKey,
      itemDigest: input.itemDigest,
      proposalDigest: input.proposalDigest,
      guardResult: input.guardResult,
      roundId: input.roundId,
    },
  });
  let decisionItemId: string | null = null;
  if (input.found === "partial") {
    const decision = await tx.engineeringAgentWorkItem.create({
      data: {
        id: randomUUID(),
        kind: "decision",
        state: "open",
        causeKey: partialRegistrationDecisionCauseKey(input.id),
        runId: null,
        reason: "registration_partial",
      },
      select: { id: true },
    });
    decisionItemId = decision.id;
  }
  await tx.engineeringAgentRegistration.update({ where: { id: input.id }, data: { result: input.found } });
  await systemAudit(
    tx,
    "engineering-agent-registrar",
    ENGINEERING_AGENT_AUDIT_ACTIONS.registrationResolved,
    "engineering_agent_registration",
    input.id,
    { source: input.source, itemDigest: input.itemDigest, result: input.found, decisionItemId },
  );
  return { recorded: true, registrationId: input.id, decisionItemId };
}

/**
 * The publisher's result for the item it claimed (§10, §11): the settlement
 * the core picks, and -- when that settlement publishes -- the binding of the
 * pull request in the same transaction, which the database requires by commit.
 * A pull request reported for a result that does not publish is refused, and
 * so is a publish reported without one. `cardId`, when given, is the AMUX
 * card whose transaction this runs in; the item's run must be that card's.
 */
export async function recordEngineeringAgentPublishResult(
  tx: EngineeringAgentTransaction,
  input: {
    workItemId: string;
    fencingToken: bigint;
    outcome: WriteResultOutcome;
    reason?: string;
    pullRequest: Omit<BindingInput, "runId"> | null;
    cardId?: string;
    /** When given, the AMUX attempt whose review the pull request is for: the item's run's own. */
    attemptId?: string;
  },
): Promise<{ state: string; decisionItemId: string | null; bindingId: string | null }> {
  const settled = await settleEngineeringAgentWorkItem(tx, {
    workItemId: input.workItemId,
    fencingToken: input.fencingToken,
    outcome: input.outcome,
    reason: input.reason,
  });
  if (settled.state !== "published") {
    if (input.pullRequest !== null) refuse("pull_request_without_publish");
    return { ...settled, bindingId: null };
  }
  if (input.pullRequest === null) refuse("published_without_pull_request");
  const item = await tx.engineeringAgentWorkItem.findUniqueOrThrow({
    where: { id: input.workItemId },
    select: { runId: true, run: { select: { cardId: true, amuxAttemptId: true } } },
  });
  const runId = item.runId ?? refuse("publish_item_without_run");
  if (input.cardId !== undefined && item.run?.cardId !== input.cardId) refuse("card_mismatch");
  if (input.attemptId !== undefined && item.run?.amuxAttemptId !== input.attemptId) refuse("attempt_mismatch");
  const { bindingId } = await recordEngineeringAgentBinding(tx, { ...input.pullRequest!, runId });
  return { ...settled, bindingId };
}

/**
 * Re-binds a pull request: the current row is superseded and its replacement
 * becomes current in the same transaction. The replacement's snapshot lists
 * the reviews the re-bind makes invalid (§9-10 condition 7).
 */
export async function replaceEngineeringAgentBinding(
  tx: EngineeringAgentTransaction,
  input: { previousBindingId: string; replacement: BindingInput },
): Promise<{ bindingId: string }> {
  const previous = await lockBinding(tx, input.previousBindingId);
  if (previous.supersededAt !== null) refuse("binding_already_superseded");
  if (previous.prNumber !== input.replacement.prNumber || previous.runId !== input.replacement.runId) {
    refuse("replacement_for_another_pull_request");
  }
  const data = bindingData(input.replacement);
  // The trigger writes the time; the value only marks the column as set.
  await tx.engineeringAgentBinding.update({ where: { id: previous.id }, data: { supersededAt: new Date(0) } });
  const created = await tx.engineeringAgentBinding.create({ data, select: { id: true } });
  await systemAudit(tx, "engineering-agent-publisher", ENGINEERING_AGENT_AUDIT_ACTIONS.bindingReplaced, "engineering_agent_binding", created.id, {
    previousBindingId: previous.id,
    prNumber: previous.prNumber,
    headSha: input.replacement.headSha,
  });
  return { bindingId: created.id };
}

/** `open -> closed` when the pull request closes; `closed -> pruned` when its branch is gone. */
export async function moveEngineeringAgentBinding(
  tx: EngineeringAgentTransaction,
  input: { bindingId: string; to: "closed" | "pruned" },
): Promise<void> {
  const binding = await lockBinding(tx, input.bindingId);
  await requireSwitch(tx, "maintenanceAllowed");
  const from = input.to === "closed" ? "open" : "closed";
  if (binding.state !== from) refuse("binding_not_in_expected_state");
  await tx.engineeringAgentBinding.update({ where: { id: binding.id }, data: { state: input.to } });
  await systemAudit(tx, "engineering-agent-observer", ENGINEERING_AGENT_AUDIT_ACTIONS.bindingMoved, "engineering_agent_binding", binding.id, {
    from,
    to: input.to,
  });
}

/**
 * Records what the observer read, once. An approval observation with verdict
 * `approved` records its reviewer, as a pair, in the same write. Recording
 * the same observation again is a no-op; recording a different one is refused
 * by the database.
 */
export async function recordEngineeringAgentBindingObservation(
  tx: EngineeringAgentTransaction,
  input:
    | {
        bindingId: string;
        kind: "approval";
        observation: z.infer<typeof engineeringAgentApprovalObservationSchema>;
        reviewer: { githubId: number; login: string } | null;
      }
    | { bindingId: string; kind: "merge"; observation: z.infer<typeof engineeringAgentMergeObservationSchema> },
): Promise<{ recorded: boolean }> {
  const binding = await lockBinding(tx, input.bindingId);
  await requireSwitch(tx, "maintenanceAllowed");
  const current = await tx.engineeringAgentBinding.findUniqueOrThrow({
    where: { id: binding.id },
    select: { approvalObservation: true, mergeObservation: true },
  });
  let data: Prisma.EngineeringAgentBindingUpdateInput;
  let existing: Prisma.JsonValue | null;
  if (input.kind === "approval") {
    const parsed = engineeringAgentApprovalObservationSchema.safeParse(input.observation);
    if (!parsed.success) refuse("observation_invalid");
    const approved = parsed.data!.verdict === "approved";
    if (approved !== (input.reviewer !== null)) refuse("reviewer_goes_with_approval");
    if (input.reviewer && (!Number.isSafeInteger(input.reviewer.githubId) || input.reviewer.githubId <= 0)) {
      refuse("reviewer_invalid");
    }
    existing = current.approvalObservation;
    data = {
      approvalObservation: parsed.data as Prisma.InputJsonObject,
      ...(input.reviewer ? { reviewerGithubId: BigInt(input.reviewer.githubId), reviewerLogin: input.reviewer.login } : {}),
    };
  } else {
    const parsed = engineeringAgentMergeObservationSchema.safeParse(input.observation);
    if (!parsed.success) refuse("observation_invalid");
    existing = current.mergeObservation;
    data = { mergeObservation: parsed.data as Prisma.InputJsonObject };
  }
  const next = input.kind === "approval" ? data.approvalObservation : data.mergeObservation;
  if (existing !== null) {
    // jsonb keeps its own key order, so the comparison is on a canonical form.
    if (canonicalJson(existing) === canonicalJson(next)) return { recorded: false };
    refuse("observation_already_recorded");
  }
  await tx.engineeringAgentBinding.update({ where: { id: binding.id }, data });
  await systemAudit(tx, "engineering-agent-observer", ENGINEERING_AGENT_AUDIT_ACTIONS.bindingObserved, "engineering_agent_binding", binding.id, {
    kind: input.kind,
    verdict: input.kind === "approval" ? input.observation.verdict : null,
    merged: input.kind === "merge" ? input.observation.merged : null,
  });
  return { recorded: true };
}

/** Retention removes the reviewer's identity, as a pair; the time it was recorded stays. */
export async function removeEngineeringAgentReviewer(
  tx: EngineeringAgentTransaction,
  input: { bindingId: string },
): Promise<void> {
  const binding = await lockBinding(tx, input.bindingId);
  await requireSwitch(tx, "maintenanceAllowed");
  await tx.engineeringAgentBinding.update({
    where: { id: binding.id },
    data: { reviewerGithubId: null, reviewerLogin: null },
  });
  await systemAudit(tx, "engineering-agent-retention", ENGINEERING_AGENT_AUDIT_ACTIONS.reviewerRemoved, "engineering_agent_binding", binding.id, {});
}
