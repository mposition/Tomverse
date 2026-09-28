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
 * calls into this module inside the same transaction. The registration path is
 * absent until the AMUX intake has the agent registration source.
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

import { writeAdminAuditLog } from "@/lib/adminAudit";
import type { EngineeringAgentSystemAuditActor } from "@/lib/adminAuditSystemActors";
import { writeEngineeringAgentSystemAudit as systemAudit } from "@/lib/engineeringAgentAudit";
import {
  ENGINEERING_AGENT_VERIFIER_VERSION,
  capabilityCommitObject,
  issueCapability,
  type IssueInput,
} from "@/lib/engineeringAgentCapability";
import {
  ENGINEERING_AGENT_FREEZE_SETTING_KEY,
  ENGINEERING_AGENT_KILL_SWITCH_ENV,
  ENGINEERING_AGENT_MODE_SETTING_KEY,
  ENGINEERING_AGENT_POLICY_VERSION,
  ENGINEERING_AGENT_REGISTRATION_SETTING_KEY,
  QUEUE_TTL_DAYS,
  WRITE_ITEM_KINDS,
  decideWriteItemTransition,
  engineeringBranchName,
  isRunId,
  resolveEngineeringAgentSwitches,
  unknownOutcomeDecisionCauseKey,
  writeItemStates,
  type EffectiveSwitches,
  type HaltValue,
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

/** The one place an `EngineeringAgentTransaction` comes from. */
export async function runEngineeringAgentTransaction<T>(
  client: PrismaClient,
  run: (tx: EngineeringAgentTransaction) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return client.$transaction((tx) => run(tx as unknown as EngineeringAgentTransaction), options);
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
  reviewerRemoved: "engineering_agent.reviewer_removed",
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

/* ------------------------------------------------------------------------- */
/* Internal request idempotency (§10)                                         */
/* ------------------------------------------------------------------------- */

const REQUEST_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const REQUEST_ROUTE = /^[a-z]+\/[a-z-]+$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type RequestAcceptance =
  | { outcome: "accepted" }
  /** The same request was seen before: its recorded state is the answer, and nothing starts again. */
  | { outcome: "replay"; state: string }
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
    select: { route: true, requestDigest: true, state: true },
  });
  if (existing) {
    return existing.route === input.route && existing.requestDigest === input.requestDigest
      ? { outcome: "replay", state: existing.state }
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
  input: { key: string; from: "accepted" | "in_progress"; to: "in_progress" | "committed" | "aborted" },
): Promise<void> {
  const moved = await tx.engineeringAgentRequest.updateMany({
    where: { key: input.key, state: input.from },
    data: { state: input.to },
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

/** Extends a live lease. A lease that has run out stays out (the trigger's rule). */
export async function heartbeatEngineeringAgentRun(
  tx: EngineeringAgentTransaction,
  input: { runId: string; leaseMs: number },
): Promise<Date> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) refuse("lease_invalid");
  const now = await databaseNow(tx);
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  const moved = await tx.engineeringAgentRun.updateMany({
    where: { id: input.runId, status: "active", leaseExpiresAt: { gt: now, lt: leaseExpiresAt } },
    data: { leaseExpiresAt },
  });
  if (moved.count !== 1) refuse("run_lease_not_live");
  return leaseExpiresAt;
}

/** Ends a run once. `abandoned` is its own status; every other outcome finishes it. */
export async function endEngineeringAgentRun(
  tx: EngineeringAgentTransaction,
  input: { runId: string; outcome: RunOutcome; halt: HaltValue },
): Promise<void> {
  const status = input.outcome === "abandoned" ? "abandoned" : "finished";
  const moved = await tx.engineeringAgentRun.updateMany({
    where: { id: input.runId, status: "active" },
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

const CAUSE_KEY = /^[a-z_]{1,20}:[!-~]{1,200}$/;
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

type LockedCapability = {
  id: string;
  verifierVersion: number;
  policyVersion: number;
  expiresAt: Date;
  consumedAt: Date | null;
  claimFencingToken: bigint | null;
};

const lockCapability = async (
  tx: EngineeringAgentTransaction,
  workItemId: string,
): Promise<LockedCapability | null> => {
  const rows = await tx.$queryRaw<LockedCapability[]>`
    SELECT "id", "verifierVersion", "policyVersion", "expiresAt", "consumedAt", "claimFencingToken"
    FROM "EngineeringAgentCapability"
    WHERE "workItemId" = ${workItemId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
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
  const now = await databaseNow(tx);

  let capability: LockedCapability | null = null;
  let context: WriteTransitionContext;
  if (input.mode === "lookup") {
    context = { event: "claim", mode: "lookup", capabilityConsumed: false };
  } else if (kind === "publish") {
    capability = await lockCapability(tx, item.id);
    if (!capability || capability.consumedAt !== null) refuse("capability_unavailable");
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
  const capability = kind === "publish" ? await lockCapability(tx, item.id) : null;
  const to = resultTarget(kind, {
    event: "result",
    claimMode: item.claimMode as WriteClaimMode,
    fencingMatches: item.fencingToken === input.fencingToken,
    outcome: input.outcome,
    capabilityConsumed: capability !== null && capability.consumedAt !== null,
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
 * Issues the one capability of a queued publish item, at the database's time,
 * under the current verifier and policy versions. The commit fields are bound
 * by digest: whoever later claims must reproduce the same commit object.
 */
export async function issueEngineeringAgentCapability(
  tx: EngineeringAgentTransaction,
  input: { workItemId: string; capability: Omit<IssueInput, "now" | "verifierVersion" | "policyVersion"> },
): Promise<{ capabilityId: string; commitDigest: string; expiresAt: Date }> {
  const item = await lockWorkItem(tx, input.workItemId);
  if (item.kind !== "publish" || item.state !== "queued") refuse("work_item_not_a_queued_publish");
  if (item.patchDigest !== input.capability.patchDigest || item.baseSha !== input.capability.baseSha) {
    refuse("capability_does_not_match_item");
  }
  if (item.runId !== input.capability.commit.runId) refuse("capability_run_mismatch");
  const now = await databaseNow(tx);
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

export const ENGINEERING_AGENT_APPROVAL_VERDICTS = ["approved", "not_approved"] as const;
export const ENGINEERING_AGENT_NOT_APPROVED_REASONS = [
  "base_not_develop",
  "head_not_verified",
  "required_check_failed",
  "no_authorised_review",
  "review_not_valid",
  "snapshot_changed",
  "review_before_snapshot",
  "merged_without_approval",
] as const;

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

export const ENGINEERING_AGENT_MERGER_KINDS = ["user", "bot", "app", "unknown"] as const;

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
  await tx.engineeringAgentBinding.update({
    where: { id: binding.id },
    data: { reviewerGithubId: null, reviewerLogin: null },
  });
  await systemAudit(tx, "engineering-agent-retention", ENGINEERING_AGENT_AUDIT_ACTIONS.reviewerRemoved, "engineering_agent_binding", binding.id, {});
}
