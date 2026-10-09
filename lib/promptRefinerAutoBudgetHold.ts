import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

/** Product spending only; never the one-shot evaluation or user-credit budget. */
export const PROMPT_REFINER_AUTO_DAY_LIMIT_MICRO_USD = 100_000_000n;
export const PROMPT_REFINER_AUTO_MONTH_LIMIT_MICRO_USD = 3_000_000_000n;
export const PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD = 29_918n;

const BRISBANE_UTC_OFFSET_MS = 10 * 60 * 60 * 1000;
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// This identifier is audited. The format prevents plain user/conversation
// text; the future caller must establish opaque server-side provenance.
const REQUEST_KEY = UUID;

export class PromptRefinerAutoBudgetError extends Error {
  constructor(readonly code: "budget_exhausted" | "budget_unavailable" | "binding_invalid") {
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

async function book(tx: Prisma.TransactionClient, input: {
  period: "brisbane_day" | "brisbane_month";
  periodStart: Date;
  limit: bigint;
}): Promise<boolean> {
  const result = await tx.$queryRaw<Array<{ count: bigint }>>`
    INSERT INTO "PromptRefinerAutoBudgetWindow" (
      "period", "periodStart", "committedMicroUsd", "updatedAt")
    VALUES (${input.period}, ${input.periodStart},
      ${PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD}, NOW())
    ON CONFLICT ("period", "periodStart") DO UPDATE
      SET "committedMicroUsd" = "PromptRefinerAutoBudgetWindow"."committedMicroUsd" +
            ${PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD},
          "updatedAt" = NOW()
      WHERE "PromptRefinerAutoBudgetWindow"."committedMicroUsd" <=
        ${input.limit - PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD}
    RETURNING "committedMicroUsd"
  `;
  return result.length === 1;
}

/**
 * Books both approved product windows atomically, with a content-free audit.
 * This is not product admission: the caller must still prove the exact
 * candidate/price/deployment, a valid conditional-release receipt, and the
 * adapter's final request before any paid dispatch. Unknown calls keep the
 * hold; no settlement or provider path is exposed by this module.
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
  if (!REQUEST_KEY.test(input.requestKey) ||
      !HEX_64.test(input.candidateDigest) ||
      !HEX_64.test(input.pricePinDigest) ||
      !UUID.test(input.runtimeDeploymentId)) {
    throw new PromptRefinerAutoBudgetError("binding_invalid");
  }

  return prisma.$transaction(async (tx) => {
    // No provider or network I/O occurs while this transaction is open.
    const clock = await tx.$queryRaw<Array<{ dbNow: Date }>>`
      SELECT transaction_timestamp() AS "dbNow"
    `;
    if (clock.length !== 1) {
      throw new PromptRefinerAutoBudgetError("budget_unavailable");
    }
    const { dayStart, monthStart } = promptRefinerAutoBudgetWindows(clock[0].dbNow);
    if (!await book(tx, { period: "brisbane_day", periodStart: dayStart,
      limit: PROMPT_REFINER_AUTO_DAY_LIMIT_MICRO_USD }) ||
        !await book(tx, { period: "brisbane_month", periodStart: monthStart,
          limit: PROMPT_REFINER_AUTO_MONTH_LIMIT_MICRO_USD })) {
      // The transaction rolls back the first booking if the second refuses.
      throw new PromptRefinerAutoBudgetError("budget_exhausted");
    }
    const id = randomUUID();
    const reservationAuditLogId = await writeSystemAuditLog({
      tx, systemActor: "prompt-refiner-auto-budget",
      action: "prompt_refiner.auto_budget_reserved",
      targetType: "PromptRefinerAutoBudgetHold", targetId: id,
      summary: "Reserved the bounded Prompt Refiner Auto product cost.",
      metadata: {
        requestKey: input.requestKey,
        candidateDigest: input.candidateDigest,
        pricePinDigest: input.pricePinDigest,
        runtimeDeploymentId: input.runtimeDeploymentId,
        reservedMicroUsd: Number(PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD),
        dayStart: dayStart.toISOString(), monthStart: monthStart.toISOString(),
      },
    });
    await tx.$executeRaw`
      INSERT INTO "PromptRefinerAutoBudgetHold" (
        "id", "requestKey", "dayStart", "monthStart", "reservedMicroUsd",
        "status", "candidateDigest", "pricePinDigest", "runtimeDeploymentId",
        "reservationAuditLogId"
      ) VALUES (
        ${id}, ${input.requestKey}, ${dayStart}, ${monthStart},
        ${PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD}, 'reserved',
        ${input.candidateDigest}, ${input.pricePinDigest},
        ${input.runtimeDeploymentId}, ${reservationAuditLogId}
      )
    `;
    return Object.freeze({ id, dayStart, monthStart,
      reservedMicroUsd: PROMPT_REFINER_AUTO_REQUEST_HOLD_MICRO_USD,
      reservationAuditLogId, dispatchAuthorized: false as const });
  }, { maxWait: 2_000, timeout: 5_000 });
}
