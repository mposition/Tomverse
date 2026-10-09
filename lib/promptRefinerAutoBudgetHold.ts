import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

/** Product spending only; never the one-shot evaluation or user-credit budget. */
export const PROMPT_REFINER_AUTO_DAY_LIMIT_MICRO_USD = BigInt(100_000_000);
export const PROMPT_REFINER_AUTO_MONTH_LIMIT_MICRO_USD = BigInt(3_000_000_000);
export const PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD = BigInt(29_918);

const BRISBANE_UTC_OFFSET_MS = 10 * 60 * 60 * 1000;
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_KEY = UUID;

export type PromptRefinerAutoBudgetBinding = Readonly<{
  holdId: string;
  requestKey: string;
  candidateDigest: string;
  pricePinDigest: string;
  runtimeDeploymentId: string;
}>;

export type PromptRefinerAutoBudgetDispatchFact = Readonly<{
  binding: PromptRefinerAutoBudgetBinding;
  intentId: string;
  /** Exact adapter/config/price contract identity; never prompt bytes. */
  adapterConfigDigest: string;
}>;

export type PromptRefinerAutoBudgetVerifiedBillingFact =
  PromptRefinerAutoBudgetDispatchFact & Readonly<{
    kind: "verified_billed";
    observationId: string;
    billedMicroUsd: bigint;
  }>;

export type PromptRefinerAutoBudgetUnknownFact =
  PromptRefinerAutoBudgetDispatchFact & Readonly<{
    kind: "billing_unknown";
    observationId: string;
  }>;

export type PromptRefinerAutoBudgetUndispatchedFact = Readonly<{
  kind: "confirmed_undispatched";
  binding: PromptRefinerAutoBudgetBinding;
  proofId: string;
  intentId: string | null;
  adapterConfigDigest: string | null;
}>;

export type PromptRefinerAutoBudgetTransitionVerifiers<
  DispatchInput = unknown,
  BillingInput = unknown,
  UnknownInput = unknown,
  UndispatchedInput = unknown,
> = Readonly<{
  verifyDispatchIntent: (input: DispatchInput) => PromptRefinerAutoBudgetDispatchFact |
    Promise<PromptRefinerAutoBudgetDispatchFact>;
  verifyVerifiedBilling: (input: BillingInput) => PromptRefinerAutoBudgetVerifiedBillingFact |
    Promise<PromptRefinerAutoBudgetVerifiedBillingFact>;
  verifyBillingUnknown: (input: UnknownInput) => PromptRefinerAutoBudgetUnknownFact |
    Promise<PromptRefinerAutoBudgetUnknownFact>;
  verifyUndispatched: (input: UndispatchedInput) => PromptRefinerAutoBudgetUndispatchedFact |
    Promise<PromptRefinerAutoBudgetUndispatchedFact>;
}>;

export class PromptRefinerAutoBudgetError extends Error {
  constructor(readonly code:
    "budget_exhausted" | "budget_unavailable" | "binding_invalid" |
    "evidence_invalid" | "transition_invalid" | "integrity_unavailable") {
    super(code);
    this.name = "PromptRefinerAutoBudgetError";
  }
}

/** Brisbane has no daylight saving; derive both windows from the DB clock. */
export function promptRefinerAutoBudgetWindows(dbNow: Date): Readonly<{
  dayStart: Date;
  monthStart: Date;
}> {
  if (!(dbNow instanceof Date) || !Number.isFinite(dbNow.getTime())) {
    throw new PromptRefinerAutoBudgetError("budget_unavailable");
  }
  const local = new Date(dbNow.getTime() + BRISBANE_UTC_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const dayStart = new Date(Date.UTC(year, month, local.getUTCDate()) -
    BRISBANE_UTC_OFFSET_MS);
  const monthStart = new Date(Date.UTC(year, month, 1) -
    BRISBANE_UTC_OFFSET_MS);
  return Object.freeze({ dayStart, monthStart });
}

function validBinding(input: Omit<PromptRefinerAutoBudgetBinding, "holdId"> &
  Partial<Pick<PromptRefinerAutoBudgetBinding, "holdId">>): boolean {
  return (input.holdId === undefined || UUID.test(input.holdId)) &&
    REQUEST_KEY.test(input.requestKey) && HEX_64.test(input.candidateDigest) &&
    HEX_64.test(input.pricePinDigest) && UUID.test(input.runtimeDeploymentId);
}

function freezeBinding(input: PromptRefinerAutoBudgetBinding): PromptRefinerAutoBudgetBinding {
  if (!validBinding(input)) throw new PromptRefinerAutoBudgetError("evidence_invalid");
  return Object.freeze({ ...input });
}

function normalizedDispatchFact(input: PromptRefinerAutoBudgetDispatchFact):
  PromptRefinerAutoBudgetDispatchFact {
  if (!input || !UUID.test(input.intentId) || !HEX_64.test(input.adapterConfigDigest)) {
    throw new PromptRefinerAutoBudgetError("evidence_invalid");
  }
  return Object.freeze({ binding: freezeBinding(input.binding),
    intentId: input.intentId, adapterConfigDigest: input.adapterConfigDigest });
}

function normalizedBillingFact(input: PromptRefinerAutoBudgetVerifiedBillingFact):
  PromptRefinerAutoBudgetVerifiedBillingFact {
  const dispatch = normalizedDispatchFact(input);
  if (input.kind !== "verified_billed" || !UUID.test(input.observationId) ||
      typeof input.billedMicroUsd !== "bigint" || input.billedMicroUsd < BigInt(0) ||
      input.billedMicroUsd > PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD) {
    throw new PromptRefinerAutoBudgetError("evidence_invalid");
  }
  return Object.freeze({ ...dispatch, kind: "verified_billed" as const,
    observationId: input.observationId, billedMicroUsd: input.billedMicroUsd });
}

function normalizedUnknownFact(input: PromptRefinerAutoBudgetUnknownFact):
  PromptRefinerAutoBudgetUnknownFact {
  const dispatch = normalizedDispatchFact(input);
  if (input.kind !== "billing_unknown" || !UUID.test(input.observationId)) {
    throw new PromptRefinerAutoBudgetError("evidence_invalid");
  }
  return Object.freeze({ ...dispatch, kind: "billing_unknown" as const,
    observationId: input.observationId });
}

function normalizedUndispatchedFact(input: PromptRefinerAutoBudgetUndispatchedFact):
  PromptRefinerAutoBudgetUndispatchedFact {
  if (!input || input.kind !== "confirmed_undispatched" || !UUID.test(input.proofId) ||
      ((input.intentId === null) !== (input.adapterConfigDigest === null)) ||
      (input.intentId !== null && !UUID.test(input.intentId)) ||
      (input.adapterConfigDigest !== null && !HEX_64.test(input.adapterConfigDigest))) {
    throw new PromptRefinerAutoBudgetError("evidence_invalid");
  }
  return Object.freeze({ kind: "confirmed_undispatched" as const,
    binding: freezeBinding(input.binding), proofId: input.proofId,
    intentId: input.intentId, adapterConfigDigest: input.adapterConfigDigest });
}

type LockedHold = {
  id: string;
  requestKey: string;
  status: string;
  candidateDigest: string;
  pricePinDigest: string;
  runtimeDeploymentId: string;
  dispatchIntentId: string | null;
  adapterConfigDigest: string | null;
};

async function lockBoundHold(tx: Prisma.TransactionClient,
  binding: PromptRefinerAutoBudgetBinding): Promise<LockedHold> {
  if (!validBinding(binding)) throw new PromptRefinerAutoBudgetError("binding_invalid");
  const rows = await tx.$queryRaw<LockedHold[]>`
    SELECT "id", "requestKey", "status", "candidateDigest", "pricePinDigest",
           "runtimeDeploymentId", "dispatchIntentId", "adapterConfigDigest"
    FROM "PromptRefinerAutoBudgetHold"
    WHERE "id" = ${binding.holdId} AND "requestKey" = ${binding.requestKey}
      AND "candidateDigest" = ${binding.candidateDigest}
      AND "pricePinDigest" = ${binding.pricePinDigest}
      AND "runtimeDeploymentId" = ${binding.runtimeDeploymentId}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new PromptRefinerAutoBudgetError("binding_invalid");
  return rows[0]!;
}

async function oneTransition(query: Promise<number>): Promise<void> {
  if (await query !== 1) throw new PromptRefinerAutoBudgetError("integrity_unavailable");
}

async function inBudgetTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '4000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
    `;
    // Global order: canonical audit chain, hold, then Brisbane day/month windows
    // (the database transition trigger owns the last two locks).
    await takeAuditChainLock(tx);
    return work(tx);
  }, { maxWait: 2_000, timeout: 5_000 });
}

/**
 * Books both approved product windows atomically, with a content-free audit.
 * The database derives and refreshes the exact window totals from durable holds.
 * This is not dispatch authority.
 */
export async function reservePromptRefinerAutoBudget(input: {
  requestKey: string;
  candidateDigest: string;
  pricePinDigest: string;
  runtimeDeploymentId: string;
}): Promise<Readonly<{
  id: string;
  dayStart: Date;
  monthStart: Date;
  reservedMicroUsd: bigint;
  reservationAuditLogId: string;
  dispatchAuthorized: false;
}>> {
  if (!validBinding(input)) throw new PromptRefinerAutoBudgetError("binding_invalid");

  return inBudgetTransaction(async (tx) => {
    const clock = await tx.$queryRaw<Array<{ dbNow: Date }>>`
      SELECT transaction_timestamp() AS "dbNow"
    `;
    if (clock.length !== 1) throw new PromptRefinerAutoBudgetError("budget_unavailable");
    const { dayStart, monthStart } = promptRefinerAutoBudgetWindows(clock[0]!.dbNow);
    const id = randomUUID();
    const reservationAuditLogId = await writeSystemAuditLog({
      tx, systemActor: "prompt-refiner-auto-budget",
      action: "prompt_refiner.auto_budget_reserved",
      targetType: "PromptRefinerAutoBudgetHold", targetId: id,
      summary: "Reserved the bounded Prompt Refiner Auto product cost.",
      metadata: { requestKey: input.requestKey,
        candidateDigest: input.candidateDigest, pricePinDigest: input.pricePinDigest,
        runtimeDeploymentId: input.runtimeDeploymentId,
        reservedMicroUsd: Number(PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD),
        dayStart: dayStart.toISOString(), monthStart: monthStart.toISOString() },
    });
    try {
      await tx.$executeRaw`
        INSERT INTO "PromptRefinerAutoBudgetHold" (
          "id", "requestKey", "dayStart", "monthStart", "reservedMicroUsd",
          "status", "candidateDigest", "pricePinDigest", "runtimeDeploymentId",
          "reservationAuditLogId"
        ) VALUES (${id}, ${input.requestKey}, ${dayStart}, ${monthStart},
          ${PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD}, 'reserved',
          ${input.candidateDigest}, ${input.pricePinDigest},
          ${input.runtimeDeploymentId}, ${reservationAuditLogId})
      `;
    } catch (error) {
      if (error instanceof Error && error.message.includes("prompt_refiner_auto_budget_exhausted")) {
        throw new PromptRefinerAutoBudgetError("budget_exhausted");
      }
      throw error;
    }
    return Object.freeze({ id, dayStart, monthStart,
      reservedMicroUsd: PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD,
      reservationAuditLogId, dispatchAuthorized: false as const });
  });
}

/**
 * Installs a server-only capability around the product admission and adapter
 * verifiers. Raw HTTP bodies cannot become spending facts: only values returned
 * by these trusted closures are cloned and frozen before a transition writer
 * sees them. The product adapter owns the closed WeakSets that the verifier
 * closures consult after dispatch and usage validation.
 */
export function createPromptRefinerAutoBudgetTransitionAuthority<
  DispatchInput = unknown,
  BillingInput = unknown,
  UnknownInput = unknown,
  UndispatchedInput = unknown
>(verifiers: PromptRefinerAutoBudgetTransitionVerifiers<
  DispatchInput, BillingInput, UnknownInput, UndispatchedInput
>) {
  return Object.freeze({
    async recordDispatchIntent(raw: DispatchInput) {
      const fact = normalizedDispatchFact(await verifiers.verifyDispatchIntent(raw));
      return inBudgetTransaction(async (tx) => {
        const hold = await lockBoundHold(tx, fact.binding);
        if (hold.status !== "reserved" || hold.dispatchIntentId !== null ||
            hold.adapterConfigDigest !== null) {
          throw new PromptRefinerAutoBudgetError("transition_invalid");
        }
        const auditLogId = await writeSystemAuditLog({ tx,
          systemActor: "prompt-refiner-auto-budget",
          action: "prompt_refiner.auto_budget_dispatch_intent_recorded",
          targetType: "PromptRefinerAutoBudgetHold", targetId: hold.id,
          summary: "Recorded one authorized Prompt Refiner Auto dispatch intent.",
          metadata: { requestKey: hold.requestKey, intentId: fact.intentId,
            adapterConfigDigest: fact.adapterConfigDigest,
            candidateDigest: hold.candidateDigest, pricePinDigest: hold.pricePinDigest,
            runtimeDeploymentId: hold.runtimeDeploymentId },
        });
        await oneTransition(tx.$executeRaw`
          UPDATE "PromptRefinerAutoBudgetHold"
          SET "status" = 'dispatching', "dispatchIntentId" = ${fact.intentId},
              "adapterConfigDigest" = ${fact.adapterConfigDigest},
              "dispatchAuditLogId" = ${auditLogId}
          WHERE "id" = ${hold.id} AND "status" = 'reserved'
        `);
        return Object.freeze({ holdId: hold.id, status: "dispatching" as const,
          intentId: fact.intentId, adapterConfigDigest: fact.adapterConfigDigest,
          dispatchAuditLogId: auditLogId });
      });
    },

    async settleVerifiedBilled(raw: BillingInput) {
      const fact = normalizedBillingFact(await verifiers.verifyVerifiedBilling(raw));
      return inBudgetTransaction(async (tx) => {
        const hold = await lockBoundHold(tx, fact.binding);
        if (hold.status !== "dispatching" || hold.dispatchIntentId !== fact.intentId ||
            hold.adapterConfigDigest !== fact.adapterConfigDigest) {
          throw new PromptRefinerAutoBudgetError("transition_invalid");
        }
        const auditLogId = await writeSystemAuditLog({ tx,
          systemActor: "prompt-refiner-auto-budget",
          action: "prompt_refiner.auto_budget_settled",
          targetType: "PromptRefinerAutoBudgetHold", targetId: hold.id,
          summary: "Settled one verified Prompt Refiner Auto provider charge.",
          metadata: { requestKey: hold.requestKey, intentId: fact.intentId,
            observationId: fact.observationId,
            adapterConfigDigest: fact.adapterConfigDigest,
            candidateDigest: hold.candidateDigest, pricePinDigest: hold.pricePinDigest,
            runtimeDeploymentId: hold.runtimeDeploymentId,
            settledMicroUsd: Number(fact.billedMicroUsd) },
        });
        await oneTransition(tx.$executeRaw`
          UPDATE "PromptRefinerAutoBudgetHold"
          SET "status" = 'settled', "settledMicroUsd" = ${fact.billedMicroUsd},
              "settlementObservationId" = ${fact.observationId},
              "settlementAuditLogId" = ${auditLogId}
          WHERE "id" = ${hold.id} AND "status" = 'dispatching'
        `);
        return Object.freeze({ holdId: hold.id, status: "settled" as const,
          settledMicroUsd: fact.billedMicroUsd, settlementAuditLogId: auditLogId });
      });
    },

    async retainUnknown(raw: UnknownInput) {
      const fact = normalizedUnknownFact(await verifiers.verifyBillingUnknown(raw));
      return inBudgetTransaction(async (tx) => {
        const hold = await lockBoundHold(tx, fact.binding);
        if (hold.status !== "dispatching" || hold.dispatchIntentId !== fact.intentId ||
            hold.adapterConfigDigest !== fact.adapterConfigDigest) {
          throw new PromptRefinerAutoBudgetError("transition_invalid");
        }
        const auditLogId = await writeSystemAuditLog({ tx,
          systemActor: "prompt-refiner-auto-budget",
          action: "prompt_refiner.auto_budget_unknown_retained",
          targetType: "PromptRefinerAutoBudgetHold", targetId: hold.id,
          summary: "Retained the full Prompt Refiner Auto hold after an unknown outcome.",
          metadata: { requestKey: hold.requestKey, intentId: fact.intentId,
            observationId: fact.observationId,
            adapterConfigDigest: fact.adapterConfigDigest,
            candidateDigest: hold.candidateDigest, pricePinDigest: hold.pricePinDigest,
            runtimeDeploymentId: hold.runtimeDeploymentId },
        });
        await oneTransition(tx.$executeRaw`
          UPDATE "PromptRefinerAutoBudgetHold"
          SET "status" = 'unknown', "unknownObservationId" = ${fact.observationId},
              "unknownAuditLogId" = ${auditLogId}
          WHERE "id" = ${hold.id} AND "status" = 'dispatching'
        `);
        return Object.freeze({ holdId: hold.id, status: "unknown" as const,
          reservedMicroUsd: PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD,
          unknownAuditLogId: auditLogId, retryAuthorized: false as const });
      });
    },

    async releaseConfirmedUndispatched(raw: UndispatchedInput) {
      const fact = normalizedUndispatchedFact(await verifiers.verifyUndispatched(raw));
      return inBudgetTransaction(async (tx) => {
        const hold = await lockBoundHold(tx, fact.binding);
        if ((hold.status !== "reserved" && hold.status !== "dispatching") ||
            (hold.status === "reserved" && (fact.intentId !== null ||
              fact.adapterConfigDigest !== null)) ||
            (hold.status === "dispatching" && (hold.dispatchIntentId !== fact.intentId ||
              hold.adapterConfigDigest !== fact.adapterConfigDigest))) {
          throw new PromptRefinerAutoBudgetError("transition_invalid");
        }
        const auditLogId = await writeSystemAuditLog({ tx,
          systemActor: "prompt-refiner-auto-budget",
          action: "prompt_refiner.auto_budget_undispatched_released",
          targetType: "PromptRefinerAutoBudgetHold", targetId: hold.id,
          summary: "Released one confirmed-undispatched Prompt Refiner Auto hold.",
          metadata: { requestKey: hold.requestKey, proofId: fact.proofId,
            intentId: fact.intentId, adapterConfigDigest: fact.adapterConfigDigest,
            candidateDigest: hold.candidateDigest, pricePinDigest: hold.pricePinDigest,
            runtimeDeploymentId: hold.runtimeDeploymentId, settledMicroUsd: 0 },
        });
        await oneTransition(tx.$executeRaw`
          UPDATE "PromptRefinerAutoBudgetHold"
          SET "status" = 'released', "settledMicroUsd" = 0,
              "releaseProofId" = ${fact.proofId},
              "settlementAuditLogId" = ${auditLogId}
          WHERE "id" = ${hold.id} AND "status" = ${hold.status}
        `);
        return Object.freeze({ holdId: hold.id, status: "released" as const,
          settledMicroUsd: BigInt(0), settlementAuditLogId: auditLogId });
      });
    },
  });
}
