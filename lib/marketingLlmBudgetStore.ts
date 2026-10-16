/**
 * The marketing LLM cost ledger's one writer (S3 plan, S3c2): reserve,
 * dispatch, settle, unknown and release, each in the caller's transaction.
 *
 * Every action takes its locks in one order -- the audit chain, the UTC
 * month, the call row -- then answers a replay from what is stored before it
 * reads any current setting, so a pin rotation, an adapter release or the kill
 * switch never changes the answer to a request already recorded. Only a new
 * write reads the deadline, the kill switch, the cap and the pins; the audit
 * row is written first and the ledger row names it.
 *
 * Each action expects a transaction of its own. The statement, idle and
 * transaction bounds it sets are transaction-local and stay in force until
 * that transaction ends, so a caller that ran more work in the same
 * transaction would run it under them. The route (S3c3) opens one per request.
 *
 * The database holds the transition rules on its own (the migration's
 * triggers); this module decides which transition a request asks for and
 * refuses the ones it should not make before the trigger would.
 */

import "server-only";

import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_LLM_ADAPTER_PROFILE,
  MARKETING_LLM_ADAPTER_VERSION,
  MARKETING_LLM_PRICE_PINS,
  MARKETING_LLM_PROVIDER,
  marketingLlmAdapterConfigDigest,
  marketingLlmCloseDigest,
  marketingLlmConfigSnapshot,
  marketingLlmDispatchDigest,
  marketingLlmRequestDigest,
  marketingLlmReservation,
  marketingLlmReservePayloadDigest,
  marketingLlmSettleOutcome,
  parseMarketingLlmMonthlyCap,
  resolveMarketingLlmPin,
  type MarketingLlmClose,
  type MarketingLlmConfigSnapshot,
  type MarketingLlmObservation,
  type MarketingLlmPricePin,
  type MarketingLlmReservePayload,
  type MarketingLlmTerminalState,
} from "@/lib/marketingLlmBudgetCore";

export const MARKETING_LLM_SYSTEM_ACTOR = "marketing-generator";

export const MARKETING_LLM_ACTIONS = {
  reserved: "marketing_llm.reserved",
  dispatched: "marketing_llm.dispatched",
  settled: "marketing_llm.settled",
  unknownRetained: "marketing_llm.unknown_retained",
  released: "marketing_llm.released",
} as const;

/** The most one ledger transaction may take; the timer is armed to it. */
export const MARKETING_LLM_TRANSACTION_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const MIN_SERVER_VERSION_NUM = 170_000;

type Tx = Prisma.TransactionClient;

/** What a new write may read. Replays read none of it. */
export type MarketingLlmBudgetEnvironment = {
  /** `null` when the kill switch cannot be read; that refuses like `true`. */
  readonly killSwitchOn: boolean | null;
  readonly monthlyCapRaw: string | undefined;
  readonly pins?: readonly MarketingLlmPricePin[];
  readonly adapterVersion?: string;
};

export type MarketingLlmRefusal =
  | "server_too_old"
  | "timeout_already_armed"
  | "deadline_too_close"
  | "kill_switch"
  | "cap_unreadable"
  | "model_not_pinned"
  | "pin_expired"
  | "adapter_profile_unknown"
  | "budget_exhausted"
  | "call_not_found"
  | "call_state"
  | "dispatch_window_closed"
  | "adapter_mismatch";

export type MarketingLlmOutcome<T> =
  | { readonly status: "ok"; readonly replay: boolean; readonly value: T }
  | { readonly status: "conflict" }
  | { readonly status: "refused"; readonly code: MarketingLlmRefusal };

const refused = (code: MarketingLlmRefusal) => ({ status: "refused", code }) as const;
const conflict = { status: "conflict" } as const;

/**
 * Bound the transaction and learn whether a new write still has time, in one
 * statement: the statement and idle bounds, the server version, that no
 * transaction timer is already running, and -- only when those hold -- the
 * fixed transaction timer, armed at the same instant the time left before the
 * generator's deadline is measured. Less than the whole transaction left means
 * `late`: a late request may still read its recorded answer back; it may not
 * write.
 */
async function bound(
  tx: Tx,
  deadlineAt: Date,
): Promise<{ readonly late: boolean } | { readonly refused: MarketingLlmRefusal }> {
  const rows = await tx.$queryRaw<Array<{ num: number; armed: string | null; set: string | null; late: boolean | null }>>(Prisma.sql`
    WITH settings AS (
      SELECT current_setting('server_version_num')::int AS num,
             current_setting('transaction_timeout', true) AS armed,
             clock_timestamp() AS at
    ), checked AS (
      SELECT *, num >= ${MIN_SERVER_VERSION_NUM} AND trim(coalesce(armed, '')) IN ('0', '0ms') AS ok
      FROM settings
    )
    -- A refusal changes nothing: every bound is set only when all three are.
    SELECT num AS "num", armed AS "armed",
           CASE WHEN ok THEN set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true) END AS "statementSet",
           CASE WHEN ok THEN set_config('idle_in_transaction_session_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true) END AS "idleSet",
           CASE WHEN ok THEN set_config('transaction_timeout', ${String(MARKETING_LLM_TRANSACTION_MS)}, true) END AS "set",
           EXTRACT(EPOCH FROM (${deadlineAt}::timestamptz - at)) * 1000 < ${MARKETING_LLM_TRANSACTION_MS} AS "late"
    FROM checked
  `);
  const row = rows[0];
  if (!row || !(Number(row.num) >= MIN_SERVER_VERSION_NUM)) return { refused: "server_too_old" };
  if (row.set === null) return { refused: "timeout_already_armed" };
  return { late: row.late !== false };
}

const newCallId = () => `c${randomBytes(12).toString("hex")}`;

// ---------------------------------------------------------------------------
// reserve

export type MarketingLlmReserveResult = {
  readonly callId: string;
  readonly reservedMicroUsd: number;
};

export async function reserveMarketingLlmCall(
  tx: Tx,
  input: { readonly payload: MarketingLlmReservePayload; readonly deadlineAt: Date },
  env: MarketingLlmBudgetEnvironment,
): Promise<MarketingLlmOutcome<MarketingLlmReserveResult>> {
  const bounds = await bound(tx, input.deadlineAt);
  if ("refused" in bounds) return refused(bounds.refused);
  await takeAuditChainLock(tx);

  // The reservation's instant, read once. Its month is the month locked here,
  // summed below and stored on the row; the insert trigger checks the stored
  // value against its own clock rather than recomputing it.
  const clock = await tx.$queryRaw<Array<{ reserveAt: string; monthKey: string }>>(Prisma.sql`
    WITH t AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at)
    SELECT to_char(t.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "reserveAt",
           to_char(t.at, 'YYYY-MM') AS "monthKey",
           pg_advisory_xact_lock(hashtextextended('marketing-llm-month:' || to_char(t.at, 'YYYY-MM'), 0))::text AS "locked"
    FROM t
  `);
  const { reserveAt, monthKey } = clock[0];

  const payloadDigest = marketingLlmReservePayloadDigest(input.payload);
  const existing = await tx.$queryRaw<Array<{ id: string; reservePayloadDigest: string; reservedMicroUsd: number }>>(
    Prisma.sql`
      SELECT "id", "reservePayloadDigest", "reservedMicroUsd" FROM "MarketingLlmCall"
      WHERE "requestKey" = ${input.payload.requestKey} FOR UPDATE
    `,
  );
  if (existing[0]) {
    if (existing[0].reservePayloadDigest !== payloadDigest) return conflict;
    return {
      status: "ok",
      replay: true,
      value: { callId: existing[0].id, reservedMicroUsd: Number(existing[0].reservedMicroUsd) },
    };
  }

  if (bounds.late) return refused("deadline_too_close");
  if (env.killSwitchOn !== false) return refused("kill_switch");
  if (input.payload.adapterProfile !== MARKETING_LLM_ADAPTER_PROFILE) return refused("adapter_profile_unknown");
  const cap = parseMarketingLlmMonthlyCap(env.monthlyCapRaw);
  if (cap === null) return refused("cap_unreadable");
  const pin = resolveMarketingLlmPin(
    env.pins ?? MARKETING_LLM_PRICE_PINS,
    input.payload.model,
    new Date(`${reserveAt}Z`),
  );
  if (!pin.ok) return refused(pin.code);

  const reservation = marketingLlmReservation(pin.pin);
  // The month's committed sum, and -- the last reading of the database clock
  // before the audit row -- whether the deadline has passed.
  const sum = await tx.$queryRaw<Array<{ total: bigint; inTime: boolean }>>(Prisma.sql`
    SELECT COALESCE(SUM("reservedMicroUsd"), 0)::bigint AS "total",
           clock_timestamp() < ${input.deadlineAt}::timestamptz AS "inTime"
    FROM "MarketingLlmCall"
    WHERE "monthStart" = (${monthKey} || '-01')::date::timestamp AND "state" <> 'released'
  `);
  if (Number(sum[0]?.total ?? 0) + reservation.reservedMicroUsd > cap) return refused("budget_exhausted");
  if (sum[0]?.inTime !== true) return refused("deadline_too_close");

  const configSnapshot = marketingLlmConfigSnapshot({
    pin: pin.pin,
    adapterVersion: env.adapterVersion ?? MARKETING_LLM_ADAPTER_VERSION,
  });
  const requestDigest = marketingLlmRequestDigest({ reservePayloadDigest: payloadDigest, configSnapshot });
  const callId = newCallId();
  const auditId = await writeSystemAuditLog({
    tx,
    systemActor: MARKETING_LLM_SYSTEM_ACTOR,
    action: MARKETING_LLM_ACTIONS.reserved,
    targetType: "MarketingLlmCall",
    targetId: callId,
    summary: "Reserved the most a marketing generator LLM call can cost.",
    metadata: {
      requestKey: input.payload.requestKey,
      generatorRunId: input.payload.generatorRunId,
      purpose: input.payload.purpose,
      model: input.payload.model,
      month: monthKey,
      reservedMicroUsd: reservation.reservedMicroUsd,
      monthlyCapMicroUsd: cap,
      requestDigest,
      pricePinDigest: configSnapshot.pricePinDigest,
    },
  });
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "MarketingLlmCall" ("id", "state", "requestKey", "reservePayloadDigest", "requestDigest",
      "configSnapshot", "generatorRunId", "purpose", "provider", "model", "reservedInputTokens",
      "reservedOutputTokens", "reservedMicroUsd", "monthStart", "reservationAuditLogId", "createdAt")
    VALUES (${callId}, 'reserved', ${input.payload.requestKey}, ${payloadDigest}, ${requestDigest},
      ${JSON.stringify(configSnapshot)}::jsonb, ${input.payload.generatorRunId}, ${input.payload.purpose},
      ${MARKETING_LLM_PROVIDER}, ${input.payload.model}, ${reservation.reservedInputTokens},
      ${reservation.reservedOutputTokens}, ${reservation.reservedMicroUsd},
      date_trunc('month', ${reserveAt}::timestamp(3)), ${auditId}, ${reserveAt}::timestamp(3))
  `);
  return { status: "ok", replay: false, value: { callId, reservedMicroUsd: reservation.reservedMicroUsd } };
}

// ---------------------------------------------------------------------------
// The call row, read for every later action.

type CallRow = {
  id: string;
  state: string;
  requestKey: string;
  configSnapshot: MarketingLlmConfigSnapshot;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  dispatchIntentId: string | null;
  dispatchDigest: string | null;
  closeDigest: string | null;
  closeReason: string | null;
  intentElsewhere: boolean;
  inTime: boolean;
  dispatchOpen: boolean;
};

/**
 * The call's month is read without a lock and locked in the same statement,
 * then the row is read FOR UPDATE: the same order as a reservation, so a close
 * and a reservation of the same month never wait on each other in opposite
 * orders. The row read also carries the last reading of the database clock
 * before the audit row: whether the deadline has passed and whether the
 * dispatch window is still open.
 */
async function lockCall(
  tx: Tx,
  callId: string,
  dispatchIntentId: string | null,
  deadlineAt: Date,
): Promise<CallRow | null> {
  const month = await tx.$queryRaw<Array<{ locked: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended('marketing-llm-month:' || to_char("monthStart", 'YYYY-MM'), 0))::text AS "locked"
    FROM "MarketingLlmCall" WHERE "id" = ${callId}
  `);
  if (!month[0]) return null;
  const rows = await tx.$queryRaw<CallRow[]>(Prisma.sql`
    SELECT "id", "state", "requestKey", "configSnapshot", "reservedInputTokens", "reservedOutputTokens",
           "dispatchIntentId", "dispatchDigest", "closeDigest", "closeReason",
           EXISTS (SELECT 1 FROM "MarketingLlmCall" other
                   WHERE other."dispatchIntentId" = ${dispatchIntentId} AND other."id" <> ${callId}) AS "intentElsewhere",
           clock_timestamp() < ${deadlineAt}::timestamptz AS "inTime",
           (clock_timestamp() AT TIME ZONE 'UTC') < "createdAt" + INTERVAL '15 minutes' AS "dispatchOpen"
    FROM "MarketingLlmCall" WHERE "id" = ${callId} FOR UPDATE
  `);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// dispatch

export type MarketingLlmDispatchResult = {
  readonly callId: string;
  readonly dispatchDigest: string;
  /** True once only: the one answer that lets the adapter call the provider. */
  readonly firstConsumption: boolean;
};

export async function dispatchMarketingLlmCall(
  tx: Tx,
  input: {
    readonly callId: string;
    readonly requestKey: string;
    readonly dispatchIntentId: string;
    readonly adapterConfigDigest: string;
    readonly deadlineAt: Date;
  },
  env: MarketingLlmBudgetEnvironment,
): Promise<MarketingLlmOutcome<MarketingLlmDispatchResult>> {
  const bounds = await bound(tx, input.deadlineAt);
  if ("refused" in bounds) return refused(bounds.refused);
  await takeAuditChainLock(tx);
  const row = await lockCall(tx, input.callId, input.dispatchIntentId, input.deadlineAt);
  if (!row) return refused("call_not_found");
  if (row.requestKey !== input.requestKey) return conflict;

  const dispatchDigest = marketingLlmDispatchDigest(input);
  if (row.dispatchIntentId !== null) {
    if (row.dispatchDigest !== dispatchDigest) return conflict;
    return { status: "ok", replay: true, value: { callId: row.id, dispatchDigest, firstConsumption: false } };
  }
  if (row.state !== "reserved") return refused("call_state");
  if (row.intentElsewhere) return conflict;
  if (bounds.late) return refused("deadline_too_close");
  if (env.killSwitchOn !== false) return refused("kill_switch");
  if (input.adapterConfigDigest !== marketingLlmAdapterConfigDigest(row.configSnapshot)) {
    return refused("adapter_mismatch");
  }
  if (!row.dispatchOpen) return refused("dispatch_window_closed");
  if (!row.inTime) return refused("deadline_too_close");

  const auditId = await writeSystemAuditLog({
    tx,
    systemActor: MARKETING_LLM_SYSTEM_ACTOR,
    action: MARKETING_LLM_ACTIONS.dispatched,
    targetType: "MarketingLlmCall",
    targetId: row.id,
    summary: "Released one provider call against a marketing LLM reservation.",
    metadata: { dispatchIntentId: input.dispatchIntentId, dispatchDigest, adapterConfigDigest: input.adapterConfigDigest },
  });
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MarketingLlmCall" SET "state" = 'dispatched', "dispatchIntentId" = ${input.dispatchIntentId},
      "adapterConfigDigest" = ${input.adapterConfigDigest}, "dispatchDigest" = ${dispatchDigest},
      "dispatchAuditLogId" = ${auditId}
    WHERE "id" = ${row.id} AND "state" = 'reserved'
  `);
  if (updated !== 1) throw new Error("marketing_llm_dispatch_lost_its_row");
  return { status: "ok", replay: false, value: { callId: row.id, dispatchDigest, firstConsumption: true } };
}

// ---------------------------------------------------------------------------
// settle, unknown, release

export type MarketingLlmCloseResult = {
  readonly callId: string;
  readonly state: MarketingLlmTerminalState;
  readonly reason: string;
};

type CloseRequest =
  | { readonly action: "settle"; readonly dispatchIntentId: string; readonly observation: MarketingLlmObservation }
  | { readonly action: "unknown"; readonly dispatchIntentId: string }
  | { readonly action: "release" };

const CLOSE_AUDIT_ACTION: Record<MarketingLlmTerminalState, string> = {
  settled: MARKETING_LLM_ACTIONS.settled,
  unknown_retained: MARKETING_LLM_ACTIONS.unknownRetained,
  released: MARKETING_LLM_ACTIONS.released,
};

/** The close a request asks for, decided from the stored row alone. */
function intendedClose(row: CallRow, request: CloseRequest): MarketingLlmClose {
  const base = { callId: row.id, requestKey: row.requestKey };
  if (request.action === "release") {
    return { ...base, action: "release", terminalState: "released", reason: "reported_undispatched" };
  }
  if (request.action === "unknown") {
    return {
      ...base,
      action: "unknown",
      terminalState: "unknown_retained",
      reason: "reported_unknown",
      dispatchIntentId: request.dispatchIntentId,
    };
  }
  const outcome = marketingLlmSettleOutcome({
    configSnapshot: row.configSnapshot,
    reservedInputTokens: row.reservedInputTokens,
    reservedOutputTokens: row.reservedOutputTokens,
    observation: request.observation,
  });
  return {
    ...base,
    action: "settle",
    terminalState: outcome.terminalState,
    reason: outcome.reason,
    dispatchIntentId: request.dispatchIntentId,
    observation: request.observation,
  };
}

async function closeMarketingLlmCall(
  tx: Tx,
  input: { readonly callId: string; readonly deadlineAt: Date; readonly request: CloseRequest },
  env: MarketingLlmBudgetEnvironment,
): Promise<MarketingLlmOutcome<MarketingLlmCloseResult>> {
  const bounds = await bound(tx, input.deadlineAt);
  if ("refused" in bounds) return refused(bounds.refused);
  await takeAuditChainLock(tx);
  const row = await lockCall(tx, input.callId, null, input.deadlineAt);
  if (!row) return refused("call_not_found");

  const { request } = input;
  if (request.action !== "release" && row.dispatchIntentId !== null && row.dispatchIntentId !== request.dispatchIntentId) {
    return conflict;
  }
  const close = intendedClose(row, request);
  const closeDigest = marketingLlmCloseDigest(close);
  if (row.closeDigest !== null) {
    // One close per call. The same request reads its answer back; anything
    // else -- another action, another observation, an expiry that got there
    // first -- is a conflict.
    if (row.closeDigest !== closeDigest) return conflict;
    return {
      status: "ok",
      replay: true,
      value: { callId: row.id, state: row.state as MarketingLlmTerminalState, reason: String(row.closeReason) },
    };
  }

  const fromState = request.action === "release" ? "reserved" : "dispatched";
  if (row.state !== fromState) return refused("call_state");
  if (bounds.late) return refused("deadline_too_close");
  if (env.killSwitchOn !== false) return refused("kill_switch");
  if (!row.inTime) return refused("deadline_too_close");

  const auditId = await writeSystemAuditLog({
    tx,
    systemActor: MARKETING_LLM_SYSTEM_ACTOR,
    action: CLOSE_AUDIT_ACTION[close.terminalState],
    targetType: "MarketingLlmCall",
    targetId: row.id,
    summary: "Closed a marketing generator LLM call in the cost ledger.",
    metadata: {
      closeAction: close.action,
      reason: close.reason,
      closeDigest,
      ...(close.observation
        ? {
            observationId: close.observation.observationId,
            reportedInputTokens: close.observation.reportedInputTokens,
            reportedOutputTokens: close.observation.reportedOutputTokens,
          }
        : {}),
    },
  });
  const observation = close.observation;
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MarketingLlmCall" SET "state" = ${close.terminalState}, "closeDigest" = ${closeDigest},
      "closeAuditLogId" = ${auditId}, "closeReason" = ${close.reason},
      "observationId" = ${observation?.observationId ?? null},
      "reportedModel" = ${observation?.reportedModel ?? null},
      "reportedServiceTier" = ${observation?.reportedServiceTier ?? null},
      "reportedInputTokens" = ${observation?.reportedInputTokens ?? null}::integer,
      "reportedOutputTokens" = ${observation?.reportedOutputTokens ?? null}::integer
    WHERE "id" = ${row.id} AND "state" = ${fromState}
  `);
  if (updated !== 1) throw new Error("marketing_llm_close_lost_its_row");
  return { status: "ok", replay: false, value: { callId: row.id, state: close.terminalState, reason: close.reason } };
}

export const settleMarketingLlmCall = (
  tx: Tx,
  input: {
    readonly callId: string;
    readonly dispatchIntentId: string;
    readonly observation: MarketingLlmObservation;
    readonly deadlineAt: Date;
  },
  env: MarketingLlmBudgetEnvironment,
) =>
  closeMarketingLlmCall(
    tx,
    {
      callId: input.callId,
      deadlineAt: input.deadlineAt,
      request: { action: "settle", dispatchIntentId: input.dispatchIntentId, observation: input.observation },
    },
    env,
  );

export const reportMarketingLlmCallUnknown = (
  tx: Tx,
  input: { readonly callId: string; readonly dispatchIntentId: string; readonly deadlineAt: Date },
  env: MarketingLlmBudgetEnvironment,
) =>
  closeMarketingLlmCall(
    tx,
    {
      callId: input.callId,
      deadlineAt: input.deadlineAt,
      request: { action: "unknown", dispatchIntentId: input.dispatchIntentId },
    },
    env,
  );

export const releaseMarketingLlmCall = (
  tx: Tx,
  input: { readonly callId: string; readonly deadlineAt: Date },
  env: MarketingLlmBudgetEnvironment,
) => closeMarketingLlmCall(tx, { callId: input.callId, deadlineAt: input.deadlineAt, request: { action: "release" } }, env);
