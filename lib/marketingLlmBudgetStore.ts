/**
 * The marketing LLM cost ledger's one writer (S3 plan, S3c2): reserve,
 * dispatch, settle, unknown and release, each in the caller's transaction.
 *
 * Every action takes its locks in one order -- the audit chain, the UTC
 * month, the call row -- then answers a replay from what is stored before it
 * reads any current setting, so a pin rotation, an adapter release or the kill
 * switch never changes the answer to a request already recorded. Only a new
 * write reads the deadline, the kill switch, the operator's settings (model and
 * cap, from the Admin Console) and the pins; the audit
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

import { Prisma, type PrismaClient } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { MARKETING_RETENTION_SETTING } from "@/lib/marketingAutomationSchema";
import { verifyMarketingAuditEvidence } from "@/lib/marketingAuditEvidence";
import {
  MARKETING_LLM_ADAPTER_PROFILE,
  MARKETING_LLM_ADAPTER_VERSION,
  MARKETING_LLM_PROVIDER,
  marketingLlmAdapterConfigDigest,
  marketingLlmCloseDigest,
  marketingLlmConfigSnapshot,
  marketingLlmConsumerDigest,
  marketingLlmDispatchDigest,
  marketingLlmRequestDigest,
  marketingLlmReservation,
  marketingLlmReservePayloadDigest,
  marketingLlmSettleOutcome,
  MARKETING_LLM_SETTINGS_KEY,
  MARKETING_LLM_WEB_SEARCH_PROFILE,
  MARKETING_OPENAI_SEARCH_OVERSHOOT_ALLOWANCE,
  parseMarketingLlmMonthlyCap,
  parseMarketingLlmSettings,
  resolveMarketingLlmPin,
  type MarketingLlmClose,
  type MarketingLlmConfigSnapshot,
  type MarketingLlmObservation,
  type MarketingLlmPricePin,
  type MarketingLlmReservePayload,
  type MarketingLlmTerminalState,
} from "@/lib/marketingLlmBudgetCore";
import { MARKETING_RETENTION_ACTIONS, MarketingStoreRefusedError } from "@/lib/marketingStore";

export const MARKETING_LLM_SYSTEM_ACTOR = "marketing-generator";

export const MARKETING_LLM_ACTIONS = {
  reserved: "marketing_llm.reserved",
  dispatched: "marketing_llm.dispatched",
  settled: "marketing_llm.settled",
  unknownRetained: "marketing_llm.unknown_retained",
  released: "marketing_llm.released",
} as const;

/**
 * What one ledger row counts against the monthly cap, in micro-USD (operator
 * decision 2026-10-23: a finished call counts at its cost, not its
 * reservation). A settled call reported its tokens, so it counts at them and
 * the pinned worst rates, plus every search its request could be billed for
 * (the provider does not report searches per call), never more than it
 * reserved. A released call never reached the provider and counts nothing.
 * Any other row -- reserved, dispatched, or kept unknown -- may have cost up
 * to its reservation, so it counts at that.
 */
export const MARKETING_LLM_COUNTED_MICRO_USD_SQL = Prisma.sql`CASE "state"
  WHEN 'released' THEN 0
  WHEN 'settled' THEN LEAST("reservedMicroUsd", ceil(
    ("reportedInputTokens"::numeric * ("configSnapshot"->'pin'->>'worstInputMicroUsdPerMillion')::numeric
     + "reportedOutputTokens"::numeric * ("configSnapshot"->'pin'->>'worstOutputMicroUsdPerMillion')::numeric)
    / 1000000)
    + CASE WHEN "configSnapshot"->>'adapterProfile' = ${MARKETING_LLM_WEB_SEARCH_PROFILE}
        THEN (COALESCE(("configSnapshot"->'pin'->>'maxWebSearchCalls')::numeric, 0) + ${MARKETING_OPENAI_SEARCH_OVERSHOOT_ALLOWANCE})
             * COALESCE(("configSnapshot"->'pin'->>'webSearchMicroUsdPerCall')::numeric, 0)
        ELSE 0 END)
  ELSE "reservedMicroUsd" END`;

/** The most one ledger transaction may take; the timer is armed to it. */
export const MARKETING_LLM_TRANSACTION_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const MIN_SERVER_VERSION_NUM = 170_000;

type Tx = Prisma.TransactionClient;

/** What a new write may read. Replays read none of it. */
export type MarketingLlmBudgetEnvironment = {
  /** `null` when the kill switch cannot be read; that refuses like `true`. */
  readonly killSwitchOn: boolean | null;
  /**
   * The catalog's pins, read by the caller before its transaction: the
   * catalog read takes another connection and may seed the registry, so it
   * never runs while this one holds the audit chain lock. None, none pinned.
   */
  readonly pins?: readonly MarketingLlmPricePin[];
  readonly adapterVersion?: string;
};

export type MarketingLlmRefusal =
  | "server_too_old"
  | "timeout_already_armed"
  | "deadline_too_close"
  | "kill_switch"
  | "cap_unreadable"
  | "model_not_selected"
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
  // The operator's settings, read after the audit chain lock that every
  // settings change also takes, so a reservation sees a change either wholly
  // before it or wholly after. Only the selected model may spend.
  const stored = await tx.$queryRaw<Array<{ value: string }>>(Prisma.sql`
    SELECT "value" FROM "AppSetting" WHERE "key" = ${MARKETING_LLM_SETTINGS_KEY}
  `);
  const settings = parseMarketingLlmSettings(stored[0]?.value);
  const cap = parseMarketingLlmMonthlyCap(settings?.monthlyUsdCap ?? undefined);
  if (settings === null || cap === null) return refused("cap_unreadable");
  if (settings.model !== input.payload.model) return refused("model_not_selected");
  const pin = resolveMarketingLlmPin(
    env.pins ?? [],
    input.payload.model,
    new Date(`${reserveAt}Z`),
  );
  if (!pin.ok) return refused(pin.code);

  const reservation = marketingLlmReservation(pin.pin);
  // The month's counted sum, and -- the last reading of the database clock
  // before the audit row -- whether the deadline has passed.
  const sum = await tx.$queryRaw<Array<{ total: bigint; inTime: boolean }>>(Prisma.sql`
    SELECT COALESCE(SUM(${MARKETING_LLM_COUNTED_MICRO_USD_SQL}), 0)::bigint AS "total",
           clock_timestamp() < ${input.deadlineAt}::timestamptz AS "inTime"
    FROM "MarketingLlmCall"
    WHERE "monthStart" = (${monthKey} || '-01')::date::timestamp
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

// ---------------------------------------------------------------------------
// expiry (S3c3b)

/** Rows the sweep examines in one run; the rest wait for the next. */
export const MARKETING_LLM_EXPIRY_BATCH_LIMIT = 200;

/**
 * The sweep has no caller's deadline. bound() is used for its timers -- the
 * statement, idle and transaction bounds -- and this value only gives it a
 * deadline far enough off that the run is never `late`.
 */
const EXPIRY_TRANSACTION_DEADLINE_MS = 60_000;

export type MarketingLlmExpiryResult = {
  readonly skipped: "kill_switch" | null;
  readonly examined: number;
  readonly released: number;
  readonly unknownRetained: number;
  readonly untouched: number;
  /** Rows whose transaction failed; the rest of the batch still ran. */
  readonly failed: number;
};

type ExpiryOutcome = "released" | "unknown_retained" | "untouched";

/**
 * Close one stale call, in its own transaction, by the database's clock.
 *
 * Same lock order as every action -- the audit chain, the call's month, then
 * the row -- but none of the three is waited for. A generator request takes the
 * chain and the month before it touches a row, so a sweep that waited on either
 * would queue behind it; instead each is tried once and, if another
 * transaction holds it, the row is left for the next run. The chain lock is
 * the shared one `takeAuditChainLock()` takes, by the same key; the test holds
 * that function's lock to show the sweep steps past it. Which rows are stale is
 * decided in the row read, not from the candidate list, so a call closed in
 * between is left alone. The close is the `expire` action: its digest differs from
 * every generator close, so a generator report that arrives later is a
 * conflict, not a second close.
 */
async function expireOne(tx: Tx, callId: string): Promise<ExpiryOutcome> {
  const bounds = await bound(tx, new Date(Date.now() + EXPIRY_TRANSACTION_DEADLINE_MS));
  if ("refused" in bounds || bounds.late) return "untouched";
  // CASE fixes the order: the month is tried only once the chain is held.
  const locks = await tx.$queryRaw<Array<{ held: boolean | null }>>(Prisma.sql`
    SELECT CASE WHEN pg_try_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))
                THEN pg_try_advisory_xact_lock(hashtextextended('marketing-llm-month:' || to_char("monthStart", 'YYYY-MM'), 0))
           END AS "held"
    FROM "MarketingLlmCall" WHERE "id" = ${callId}
  `);
  if (locks[0]?.held !== true) return "untouched";
  const rows = await tx.$queryRaw<
    Array<{ id: string; requestKey: string; dispatchIntentId: string | null; reservationExpired: boolean; dispatchExpired: boolean }>
  >(Prisma.sql`
    SELECT "id", "requestKey", "dispatchIntentId",
           ("state" = 'reserved' AND "createdAt" + INTERVAL '15 minutes' <= (clock_timestamp() AT TIME ZONE 'UTC')) AS "reservationExpired",
           ("state" = 'dispatched' AND "dispatchedAt" + INTERVAL '1 hour' <= (clock_timestamp() AT TIME ZONE 'UTC')) AS "dispatchExpired"
    FROM "MarketingLlmCall" WHERE "id" = ${callId}
    FOR UPDATE SKIP LOCKED
  `);
  const row = rows[0];
  if (!row || (!row.reservationExpired && !row.dispatchExpired)) return "untouched";

  const close: MarketingLlmClose = row.reservationExpired
    ? { callId: row.id, requestKey: row.requestKey, action: "expire", terminalState: "released", reason: "reservation_expired" }
    : {
        callId: row.id,
        requestKey: row.requestKey,
        action: "expire",
        terminalState: "unknown_retained",
        reason: "dispatch_expired",
        dispatchIntentId: row.dispatchIntentId ?? undefined,
      };
  const fromState = row.reservationExpired ? "reserved" : "dispatched";
  const closeDigest = marketingLlmCloseDigest(close);
  const auditId = await writeSystemAuditLog({
    tx,
    systemActor: MARKETING_LLM_SYSTEM_ACTOR,
    action: CLOSE_AUDIT_ACTION[close.terminalState],
    targetType: "MarketingLlmCall",
    targetId: row.id,
    summary: "Closed a stale marketing generator LLM call in the cost ledger.",
    metadata: { closeAction: close.action, reason: close.reason, closeDigest },
  });
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MarketingLlmCall" SET "state" = ${close.terminalState}, "closeDigest" = ${closeDigest},
      "closeAuditLogId" = ${auditId}, "closeReason" = ${close.reason}
    WHERE "id" = ${row.id} AND "state" = ${fromState}
  `);
  if (updated !== 1) throw new Error("marketing_llm_expiry_lost_its_row");
  return close.terminalState === "released" ? "released" : "unknown_retained";
}

/**
 * The 15-minute sweep: a reservation never dispatched within 15 minutes is
 * released, and a dispatch never reported within an hour is kept at its
 * reservation as unknown. Nothing runs while the kill switch is on; the
 * sweep resumes when it is lifted. Each row is its own transaction: a row that
 * fails is counted and the rest of the batch still runs, so one bad row cannot
 * keep every later reservation holding the month's budget. A rerun finds only
 * what is still open.
 *
 * `expire` wraps the per-row step, given it as `next`, only so a test can make
 * one row fail; production passes nothing.
 */
export async function expireMarketingLlmCalls(
  prisma: PrismaClient,
  input: {
    readonly killSwitchOn: boolean | null;
    readonly limit?: number;
    readonly expire?: (
      tx: Tx,
      callId: string,
      next: (tx: Tx, callId: string) => Promise<ExpiryOutcome>,
    ) => Promise<ExpiryOutcome>;
  },
): Promise<MarketingLlmExpiryResult> {
  const empty = { examined: 0, released: 0, unknownRetained: 0, untouched: 0, failed: 0 };
  if (input.killSwitchOn !== false) return { skipped: "kill_switch", ...empty };
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MarketingLlmCall"
    WHERE ("state" = 'reserved' AND "createdAt" + INTERVAL '15 minutes' <= (clock_timestamp() AT TIME ZONE 'UTC'))
       OR ("state" = 'dispatched' AND "dispatchedAt" + INTERVAL '1 hour' <= (clock_timestamp() AT TIME ZONE 'UTC'))
    ORDER BY "createdAt", "id"
    LIMIT ${input.limit ?? MARKETING_LLM_EXPIRY_BATCH_LIMIT}
  `);
  const counts = { ...empty, examined: candidates.length };
  const expire = input.expire
    ? (tx: Tx, callId: string) => input.expire!(tx, callId, expireOne)
    : expireOne;
  for (const { id } of candidates) {
    let outcome: ExpiryOutcome;
    try {
      outcome = await prisma.$transaction((tx) => expire(tx, id), { maxWait: 5_000, timeout: 15_000 });
    } catch {
      counts.failed += 1;
      continue;
    }
    if (outcome === "released") counts.released += 1;
    else if (outcome === "unknown_retained") counts.unknownRetained += 1;
    else counts.untouched += 1;
  }
  return { skipped: null, ...counts };
}

// ---------------------------------------------------------------------------
// legal hold and retention (S3c3c)

/**
 * The predecessor a first hold decision names. Outside the id alphabet, so it
 * cannot be mistaken for an audit row; the database's guard uses the same.
 */
export const MARKETING_LLM_NO_HOLD_DECISION = ":none";

export const MARKETING_LLM_HOLD_ACTIONS = {
  set: "marketing_llm.legal_hold_set",
  released: "marketing_llm.legal_hold_released",
} as const;

/**
 * A person puts a call under legal hold, or takes it off. The hold keeps the
 * row past its 24-month retention until it is released.
 *
 * Each decision names the one it replaces: `expectedHoldAuditLogId` is the
 * audit row of the decision the person's page showed (null for a row never
 * held). The audit row this decision wrote -- a person's, written by the
 * admin mutation before this runs -- must be evidence of exactly this action
 * on this call and must name the same predecessor; the update then moves the
 * flag and the stored decision together, and only from that predecessor. So
 * neither an earlier release presented again nor a release meant for an older
 * hold can lift a newer one.
 */
export async function setMarketingLlmCallLegalHold(
  tx: Tx,
  input: {
    readonly callId: string;
    readonly hold: boolean;
    readonly auditLogId: string;
    readonly expectedHoldAuditLogId: string | null;
  },
): Promise<void> {
  const verdict = await verifyMarketingAuditEvidence(tx, {
    auditLogId: input.auditLogId,
    action: input.hold ? MARKETING_LLM_HOLD_ACTIONS.set : MARKETING_LLM_HOLD_ACTIONS.released,
    targetId: input.callId,
    metadata: { previousHoldAuditLogId: input.expectedHoldAuditLogId ?? MARKETING_LLM_NO_HOLD_DECISION },
  });
  if (!verdict.ok) {
    throw new MarketingStoreRefusedError(
      `audit_evidence_${verdict.problem}`,
      `The audit entry is not evidence of this write: ${verdict.problem}`,
    );
  }
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MarketingLlmCall" SET "legalHold" = ${input.hold}, "legalHoldAuditLogId" = ${input.auditLogId}
    WHERE "id" = ${input.callId} AND "legalHold" = ${!input.hold}
      AND "legalHoldAuditLogId" IS NOT DISTINCT FROM ${input.expectedHoldAuditLogId}
  `);
  if (updated !== 1) {
    throw new MarketingStoreRefusedError("legal_hold_conflict", "The call or its legal-hold state changed");
  }
}

/** Rows retention deletes in one run; the rest wait for the next. */
export const MARKETING_LLM_RETENTION_BATCH_LIMIT = 200;

/**
 * Delete closed calls whose 24-month retention has ended and that are not on
 * legal hold (docs/policy/marketing-automation.md §12.2), each with a
 * `marketing-retention` audit row in this transaction. The delete trigger
 * repeats every condition and refuses anything else; the retention setting is
 * what tells it this is retention. No `retention_run` report: that report's
 * table list is part of the webhook pipeline's watched source, and the audit
 * rows and the step's count already record what went.
 */
export async function purgeExpiredMarketingLlmCalls(
  tx: Tx,
  limit: number = MARKETING_LLM_RETENTION_BATCH_LIMIT,
): Promise<{ readonly purged: number }> {
  await tx.$queryRaw(Prisma.sql`SELECT set_config(${MARKETING_RETENTION_SETTING}, 'on', true)`);
  await takeAuditChainLock(tx);
  const take = Math.max(0, Math.min(Math.floor(limit), MARKETING_LLM_RETENTION_BATCH_LIMIT));
  const due = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MarketingLlmCall"
    WHERE "retentionUntil" < (clock_timestamp() AT TIME ZONE 'UTC')
      AND NOT "legalHold"
      AND "state" IN ('settled', 'unknown_retained', 'released')
    ORDER BY "retentionUntil", "id"
    LIMIT ${take}
    FOR UPDATE SKIP LOCKED
  `);
  let purged = 0;
  for (const { id } of due) {
    await writeSystemAuditLog({
      tx,
      systemActor: "marketing-retention",
      action: MARKETING_RETENTION_ACTIONS.rowPurged,
      targetType: "MarketingLlmCall",
      targetId: id,
      summary: "Deleted a marketing LLM cost ledger row its retention period had ended for.",
      metadata: { table: "MarketingLlmCall" },
    });
    const deleted = await tx.$executeRaw(Prisma.sql`DELETE FROM "MarketingLlmCall" WHERE "id" = ${id}`);
    if (deleted !== 1) throw new Error("marketing_llm_retention_lost_its_row");
    purged += 1;
  }
  return { purged };
}

// ---------------------------------------------------------------------------
// consumption by a draft submission (S3c4)

export type MarketingLlmConsumptionRefusal =
  | "intake_llm_call_missing"
  | "intake_llm_call_other_run"
  | "intake_llm_call_not_draft"
  | "intake_llm_call_open"
  | "intake_llm_call_consumed";

/**
 * Bind the calls a submission names to that submission, in the intake's
 * transaction. Every named call must exist, belong to the same generator run,
 * have been made for a draft, and be closed (settled or kept at its
 * reservation as unknown); it must be unconsumed or already consumed by this
 * very submission -- the same submission's next draft, or its resubmission.
 * Anything else refuses the draft and writes nothing.
 *
 * The caller holds the audit chain lock, which every ledger action takes
 * first, so no ledger action is between its locks while these rows are read;
 * the sweep tries its locks and steps past.
 */
export async function consumeMarketingLlmCallsForSubmission(
  tx: Tx,
  input: {
    readonly generatorRunId: string;
    readonly requestKeys: readonly string[];
    readonly submissionDigest: string;
  },
): Promise<{ readonly ok: true; readonly consumerDigest: string } | { readonly ok: false; readonly code: MarketingLlmConsumptionRefusal }> {
  const consumerDigest = marketingLlmConsumerDigest(input.submissionDigest);
  const keys = [...input.requestKeys];
  const rows = await tx.$queryRaw<
    Array<{ requestKey: string; generatorRunId: string; purpose: string; state: string; consumerDigest: string | null }>
  >(Prisma.sql`
    SELECT "requestKey", "generatorRunId", "purpose", "state", "consumerDigest"
    FROM "MarketingLlmCall" WHERE "requestKey" = ANY(${keys}::text[])
    ORDER BY "id"
    FOR UPDATE
  `);
  if (rows.length !== new Set(keys).size) return { ok: false, code: "intake_llm_call_missing" };
  for (const row of rows) {
    if (row.generatorRunId !== input.generatorRunId) return { ok: false, code: "intake_llm_call_other_run" };
    if (row.purpose !== "draft") return { ok: false, code: "intake_llm_call_not_draft" };
    if (row.state !== "settled" && row.state !== "unknown_retained") return { ok: false, code: "intake_llm_call_open" };
    if (row.consumerDigest !== null && row.consumerDigest !== consumerDigest) {
      return { ok: false, code: "intake_llm_call_consumed" };
    }
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "MarketingLlmCall" SET "consumerDigest" = ${consumerDigest}
    WHERE "requestKey" = ANY(${keys}::text[]) AND "consumerDigest" IS NULL
  `);
  return { ok: true, consumerDigest };
}
