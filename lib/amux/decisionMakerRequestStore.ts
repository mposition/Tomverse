import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { dmKeyPeriodOf, dmOptionSetDigest, dmRequestDigestKey } from "@/lib/amux/decisionMakerBodyCore";
import { dmInstanceForProvider, routeDmQuestion } from "@/lib/amux/decisionMakerCore";
import { decisionMakerPeriodKey, type DmDigestKeyRing } from "@/lib/amux/decisionMakerDigestKeys";
import {
  DM_ROUTING_BINDING_KEYS,
  DM_STALE_CLOSE_AFTER_MS,
  DM_VALIDATION_LATCH_WINDOW,
  DM_VENDOR_FOR_INSTANCE,
  dmEventAuditMetadata,
  dmEventRefusal,
  dmRequestAuditMetadata,
  dmRequestStateFromRow,
  dmTransmitSwitchRefusal,
  dmResultLookup,
  dmCleanupLatchDecision,
  dmOwedLatchReason,
  dmSwitchInputWithOwedLatch,
  dmValidationLatchDecision,
  parseDmCard,
  dmResultSubmissionOutcome,
  isDmDeadlineResultKind,
  isDmDigest,
  isDmRequestId,
  parseDmRequestRecord,
  parseDmRoutingBinding,
  parseDmResultSubmission,
  parseDmTransmission,
  type DmEventAttempt,
  type DmEventRefusal,
  type DmRequestRoute,
  type DmRequestState,
  type DmResultKind,
  type DmResultLookup,
  type DmResultRejectionReason,
  type DmCleanupLatchDecision,
  type DmTransmitSwitchRefusal,
  type DmValidationLatchDecision,
} from "@/lib/amux/decisionMakerRequestCore";
import {
  writeDecisionMakerEventAudit,
  writeDecisionMakerRouteAudit,
} from "@/lib/amux/decisionMakerRequestSystemAudit";
import {
  DM_INSTANCE_SCOPES,
  dmSwitchRoutingInput,
  isDmInstanceScope,
  type DecisionMakerSwitchRead,
  type DmInstanceScope,
  type DmSwitchLatchReason,
} from "@/lib/amux/decisionMakerSwitchCore";
import {
  latchDecisionMakerInstanceOff,
  readDecisionMakerSwitchesWithBoundariesOrThrow,
  type DecisionMakerSwitchEventRecord,
} from "@/lib/amux/decisionMakerSwitchStore";

/**
 * The one module that reads and writes `AmuxDecisionMakerRequest` and
 * `AmuxDecisionMakerRequestEvent` (docs/policy/amux-decision-maker.md §10:
 * "단일 writer 모듈이 위 표들에 쓴다"). Nothing else in the application names
 * either table; tests/amuxDecisionMakerRequest.test.mjs and `npm run
 * check:protected-table-writers` fail on another writer. The one other writer
 * is the database itself: since stage S1e the judgment table's trigger writes
 * a person's judgment as the request's closing event (confirm, edit_confirm or
 * reject), in the judgment's own statement.
 *
 * Every function runs on a transaction its caller owns and holds no lock
 * beyond it. Each sends a fixed list of statements -- no loop -- pinned by
 * tests/amuxDecisionMakerRequest.test.mjs, because the route transactions that
 * will call them have §9's budget of 12 statements including the boundary's
 * setup and fence. A write takes the audit chain lock first, reads the
 * request's state in one statement, decides with the pure core
 * (lib/amux/decisionMakerRequestCore.ts), and then writes the system audit and
 * the row naming it. A refusal the core sees writes nothing.
 *
 * The rules a stored row must satisfy are the database's (migration
 * 20261008090100_amux_decision_maker_request_ledger); this module only builds
 * rows that pass them, so the caller gets an answer rather than an aborted
 * transaction. The trigger re-checks every one under its own per-request lock.
 *
 * The three deadline writes -- an assignment, a transmission intent and a DM
 * output -- take the caller's `requireLeaseAt`, which in `withAmuxDbBoundary`
 * lowers the commit fence's deadline D to the window's end less the commit
 * reserve (lib/amux/dbBoundary.ts, the AmuxCommitDeadline device, §9). The
 * ledger's own deferred constraint trigger refuses the same COMMIT at the same
 * D, so the database holds the deadline even for a caller outside the boundary.
 *
 * The switches are never the caller's to pass in (§6, §8). A routing, a
 * transmission intent and a result read them here, with the switch store's own
 * reader, after the audit chain lock -- the lock every switch change also takes
 * before it writes -- and decide on that read in the same transaction, so a
 * switch change either committed before the read or waits for this write to
 * commit. The ledger's triggers read the switches again under the Decision
 * Maker switch gate, which the switch guard takes exclusive, so the database
 * refuses the same writes even for a caller that skipped this module. Lock
 * order: the audit chain lock, the switch gate (in the triggers), then the
 * per-request or per-scope lock.
 *
 * Since 2026-10-17 it also decides §8's validation latch, which follows from
 * the ledger: three validation failures in a row. It decides on its own reads
 * and the switch store's, and turns the instance off through the switch
 * store's latch -- it never names the switch table. Since stage S2-2a3 it
 * also records §5's report of a request whose directories the broker could
 * not confirm deleted (`cleanup_unknown`, once per request) and decides the
 * latch that report owes (`cleanup_latch`), in a transaction of its own after
 * the report commits. A latch that is owed but
 * not yet written -- either cause -- already holds the instance off for a
 * routing and a transmission intent (`dmSwitchInputWithOwedLatch()`): the
 * switch read those writers take carries each instance's newest event, and
 * the result kinds and the newest report since it ride in a statement they
 * already send (the routing) or one more (the intent), so no question reaches
 * that instance and no card its vendor.
 *
 * No card text, prompt, proposal or free text is written by it.
 */

type LedgerReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export class DecisionMakerRequestWriteError extends Error {
  readonly code:
    | "invalid_input"
    | "state_unreadable"
    | "settings_unreadable"
    | "digest_key_unavailable"
    | "key_period_changed";

  constructor(code: DecisionMakerRequestWriteError["code"]) {
    super(code);
    this.name = "DecisionMakerRequestWriteError";
    this.code = code;
  }
}

/**
 * The switches for a write that follows in the same transaction (§6, §8), by
 * the switch store's reader, after the audit chain lock. A read that fails
 * has aborted the PostgreSQL transaction, so nothing this module would write
 * next could run: it is reported as `settings_unreadable` here, before any
 * other statement, and the caller's transaction rolls back with nothing
 * written. Before 2026-10-08 the read was the fail-closed reader, whose
 * unreadable state let routing go on to write an operator row into the
 * aborted transaction and let a refused transmission intent reach a COMMIT
 * that could not commit (the S1c review minor). A SAVEPOINT around the read
 * would keep the transaction usable at two more statements on every routing,
 * intent and result -- a routing with an integrity key would then send 13
 * with the boundary's two, over §9's 12. Rows the switch store could not have
 * written still read as unreadable and are decided as before.
 *
 * Since 2026-10-17 the same one statement also carries each instance's newest
 * switch event, the boundary §8's validation count starts from.
 */
const readSwitchesForWrite = async (tx: Prisma.TransactionClient): Promise<DecisionMakerSwitchRead> => {
  try {
    return await readDecisionMakerSwitchesWithBoundariesOrThrow(tx);
  } catch {
    throw new DecisionMakerRequestWriteError("settings_unreadable");
  }
};

/**
 * §5, §8: the latch `instance` owes, if any -- §5's when its newest
 * `cleanup_unknown` report has no `cleanup_latch` at or after it, otherwise
 * §8's when a run of three validation failures stands since its newest switch
 * event (`dmOwedLatchReason()`) -- on what the caller read. A kind the ledger
 * could not hold, or a clock the stores could not have written, throws
 * `state_unreadable`, and nothing is written: an owed latch is never guessed
 * away.
 */
const owedLatch = (
  read: DecisionMakerSwitchRead,
  instance: DmInstanceScope,
  inputs: { resultKindsNewestFirst: unknown[]; newestCleanupUnknownAtMs: number | null },
): DmSwitchLatchReason | null => {
  const owed = dmOwedLatchReason({
    newestEvent: read.newest[instance],
    cleanupLatchedAtMs: read.cleanupLatchedAtMs[instance],
    resultKindsNewestFirst: inputs.resultKindsNewestFirst,
    newestCleanupUnknownAtMs: inputs.newestCleanupUnknownAtMs,
  });
  if (owed === null) throw new DecisionMakerRequestWriteError("state_unreadable");
  return owed.reason;
};

const safeInteger = (value: unknown, label: string): number => {
  const number = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`AMUX Decision Maker ledger ${label} is not a safe integer`);
  return number;
};

/**
 * The database clock of an instance's newest `cleanup_unknown` report as a
 * read returned it: null when there is none, otherwise epoch milliseconds. A
 * value the read could not have produced -- a missing column included --
 * throws `state_unreadable`.
 */
const newestReportClock = (value: unknown): number | null => {
  if (value === null) return null;
  const number = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new DecisionMakerRequestWriteError("state_unreadable");
  return number;
};

const isoOf = (epochMs: number) => new Date(epochMs).toISOString();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const requireSinceMs = (sinceMs: unknown): number => {
  if (sinceMs !== null && (typeof sinceMs !== "number" || !Number.isSafeInteger(sinceMs) || sinceMs < 0)) {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  // The epoch itself when there is no boundary: every result is after it.
  return sinceMs ?? 0;
};

/**
 * What a routing reads of `instance`, in one statement: requests routed to it
 * for a proposal in the trailing hour and day by the database clock -- the
 * throughput input of `routeDmQuestion()` (§3-6) -- and, since 2026-10-17,
 * the kinds of its terminal results recorded at or after `sinceMs` (its newest
 * switch event's database clock), newest first, at most
 * DM_VALIDATION_LATCH_WINDOW: whether §8's latch is owed -- and, since stage
 * S2-2a3, the database clock of its newest `cleanup_unknown` report: whether
 * §5's latch is owed. All ride in the statement the routing already sent, so
 * the routing's count is unchanged.
 * `recordDecisionMakerRequest()` reads it after the audit chain lock, so two
 * routings of the same instance count each other.
 */
export async function readDecisionMakerInstanceLoad(
  client: LedgerReader,
  input: { instance: DmInstanceScope; sinceMs: number | null },
): Promise<{
  lastHour: number;
  lastDay: number;
  resultKindsNewestFirst: unknown[];
  newestCleanupUnknownAtMs: number | null;
}> {
  if (!isDmInstanceScope(input.instance)) throw new DecisionMakerRequestWriteError("invalid_input");
  const sinceMs = requireSinceMs(input.sinceMs);
  const rows = await client.$queryRaw<
    Array<{ lastHour: bigint | number; lastDay: bigint | number; resultKinds: unknown; newestCleanupUnknownAtEpochMs: unknown }>
  >`
    WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS "now"),
    throughput AS MATERIALIZED (
      SELECT
        count(*) FILTER (WHERE r."createdAt" > db_clock."now" - INTERVAL '1 hour') AS "lastHour",
        count(*) AS "lastDay"
      FROM "AmuxDecisionMakerRequest" r CROSS JOIN db_clock
      WHERE r."route" = 'dm_proposal'
        AND r."instance" = ${input.instance}
        AND r."createdAt" > db_clock."now" - INTERVAL '1 day'
    )
    SELECT
      throughput."lastHour",
      throughput."lastDay",
      ARRAY(
        SELECT ev."resultKind"
        FROM "AmuxDecisionMakerRequestEvent" ev
        WHERE ev."kind" = 'result'
          AND ev."instance" = ${input.instance}
          AND ev."createdAt" >= 'epoch'::timestamptz + ${sinceMs} * INTERVAL '1 millisecond'
        ORDER BY ev."sequence" DESC
        LIMIT ${DM_VALIDATION_LATCH_WINDOW}
      ) AS "resultKinds",
      (
        SELECT floor(extract(epoch FROM max(c."createdAt")) * 1000)::bigint
        FROM "AmuxDecisionMakerRequestEvent" c
        WHERE c."kind" = 'cleanup_unknown'
          AND c."instance" = ${input.instance}
      ) AS "newestCleanupUnknownAtEpochMs"
    FROM throughput
  `;
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker instance load read returned no row");
  if (!Array.isArray(row.resultKinds)) throw new DecisionMakerRequestWriteError("state_unreadable");
  return {
    lastHour: safeInteger(row.lastHour, "count"),
    lastDay: safeInteger(row.lastDay, "count"),
    resultKindsNewestFirst: [...row.resultKinds],
    newestCleanupUnknownAtMs: newestReportClock(row.newestCleanupUnknownAtEpochMs),
  };
}

/**
 * A request's state in one statement: the request row, the database clock,
 * and what its events add up to. `probeDigest` also reports the rejection
 * already recorded for that result digest, if any. Null when no such request
 * exists; a row the core cannot read throws. Its closing kind is the router's
 * (assign_discarded, stale_close) or, since stage S1e, a person's judgment
 * (confirm, edit_confirm, reject), which the database writes beside the
 * judgment row -- one per request either way. Since stage S2-2a3 it also
 * carries the request's one `cleanup_unknown` report (§5), with its database
 * clock; that report closes nothing.
 */
export async function readDecisionMakerRequestState(
  client: LedgerReader,
  requestId: string,
  probeDigest: string | null = null,
): Promise<DmRequestState | null> {
  if (!isDmRequestId(requestId) || (probeDigest !== null && !isDmDigest(probeDigest))) {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const rows = await client.$queryRaw<unknown[]>`
    SELECT
      r."id", r."cardId", r."questionRevision", r."askingWorkerId", r."amuxSessionId",
      r."amuxSessionAttempt", r."askingProvider", r."optionSetDigest", r."policyVersion",
      r."termListVersion", r."classificationVersion", r."scannerVersion", r."route", r."instance",
      floor(extract(epoch FROM r."createdAt") * 1000)::bigint AS "createdAtEpochMs",
      floor(extract(epoch FROM r."assignmentDeadlineAt") * 1000)::bigint AS "assignmentDeadlineAtEpochMs",
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowEpochMs",
      e."assigned", e."resultDeadlineAtEpochMs", e."transmitted", e."snapshotState",
      e."snapshotTargetSha", e."snapshotManifestDigest", e."inputPayloadDigest", e."transmitOutcome",
      e."terminalEventId", e."terminalResultKind", e."terminalResultDigest", e."resultUnknown",
      e."cleanupUnknownEventId", e."cleanupUnknownAtEpochMs", e."closingKind", e."probedRejection"
    FROM "AmuxDecisionMakerRequest" r
    CROSS JOIN LATERAL (
      SELECT
        coalesce(bool_or(ev."kind" = 'assign'), false) AS "assigned",
        floor(extract(epoch FROM max(ev."resultDeadlineAt")) * 1000)::bigint AS "resultDeadlineAtEpochMs",
        coalesce(bool_or(ev."kind" = 'transmit_intent'), false) AS "transmitted",
        max(ev."snapshotState") FILTER (WHERE ev."kind" = 'transmit_intent') AS "snapshotState",
        max(ev."snapshotTargetSha") FILTER (WHERE ev."kind" = 'transmit_intent') AS "snapshotTargetSha",
        max(ev."snapshotManifestDigest") FILTER (WHERE ev."kind" = 'transmit_intent') AS "snapshotManifestDigest",
        max(ev."inputPayloadDigest") FILTER (WHERE ev."kind" = 'transmit_intent') AS "inputPayloadDigest",
        max(ev."kind") FILTER (WHERE ev."kind" IN ('transmit_receipt', 'transmit_unknown')) AS "transmitOutcome",
        max(ev."id") FILTER (WHERE ev."kind" = 'result') AS "terminalEventId",
        max(ev."resultKind") FILTER (WHERE ev."kind" = 'result') AS "terminalResultKind",
        max(ev."resultDigest") FILTER (WHERE ev."kind" = 'result') AS "terminalResultDigest",
        coalesce(bool_or(ev."kind" = 'result_unknown'), false) AS "resultUnknown",
        max(ev."id") FILTER (WHERE ev."kind" = 'cleanup_unknown') AS "cleanupUnknownEventId",
        floor(extract(epoch FROM max(ev."createdAt") FILTER (WHERE ev."kind" = 'cleanup_unknown')) * 1000)::bigint
          AS "cleanupUnknownAtEpochMs",
        max(ev."kind") FILTER (
          WHERE ev."kind" IN ('assign_discarded', 'stale_close', 'confirm', 'edit_confirm', 'reject')
        ) AS "closingKind",
        min(ev."rejectionReason") FILTER (
          WHERE ev."kind" = 'result_rejected' AND ev."resultDigest" = ${probeDigest}::text
        ) AS "probedRejection"
      FROM "AmuxDecisionMakerRequestEvent" ev
      WHERE ev."requestId" = r."id"
    ) e
    WHERE r."id" = ${requestId}
  `;
  if (rows.length === 0) return null;
  const state = dmRequestStateFromRow(rows[0]);
  if (!state) throw new DecisionMakerRequestWriteError("state_unreadable");
  return state;
}

/**
 * §9: what a submitter that lost a response learns from the (request, digest)
 * pair, in one read and without writing. Null when no such request exists.
 */
export async function lookupDecisionMakerResult(
  client: LedgerReader,
  input: { requestId: string; resultDigest: string },
): Promise<DmResultLookup | null> {
  const state = await readDecisionMakerRequestState(client, input.requestId, input.resultDigest);
  return state === null ? null : dmResultLookup(state, input.resultDigest);
}

/**
 * Requests routed to a DM, created in [from, to) by the database clock, that
 * no closing event has closed, in one statement. Stage S1d's digest-key
 * destruction reads it for one key period (§10): a body can still be stored
 * for an open request, so a period's key is not destroyed while one is open.
 * A judgment closes a request as well (stage S1e), as the key guard counts it.
 * Bounds are epoch milliseconds, added to the epoch as an interval so the
 * comparison is exact.
 */
export async function countOpenDecisionMakerRequestsCreatedBetween(
  client: LedgerReader,
  input: { fromMs: number; toMs: number },
): Promise<number> {
  if (
    !Number.isSafeInteger(input.fromMs) ||
    !Number.isSafeInteger(input.toMs) ||
    input.fromMs < 0 ||
    input.toMs <= input.fromMs
  ) {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const rows = await client.$queryRaw<Array<{ open: bigint | number }>>`
    SELECT count(*) AS "open"
    FROM "AmuxDecisionMakerRequest" r
    WHERE r."route" = 'dm_proposal'
      AND r."createdAt" >= 'epoch'::timestamptz + ${input.fromMs} * INTERVAL '1 millisecond'
      AND r."createdAt" < 'epoch'::timestamptz + ${input.toMs} * INTERVAL '1 millisecond'
      AND NOT EXISTS (
        SELECT 1 FROM "AmuxDecisionMakerRequestEvent" ev
        WHERE ev."requestId" = r."id"
          AND ev."kind" IN ('assign_discarded', 'stale_close', 'confirm', 'edit_confirm', 'reject')
      )
  `;
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker open request count returned no row");
  return safeInteger(row.open, "count");
}

/**
 * Requests routed to a DM that no closing event has closed and that are at
 * least 720 hours old by the database clock -- the ones §10's stale close
 * applies to -- oldest first, at most `limit` (1 to 100), in one statement.
 * For the system sweep (lib/amux/decisionMakerRetentionSweep.ts); each is then
 * closed in a transaction of its own, which decides again under the request
 * lock. The closing kinds are the same list the open-request count reads.
 */
export async function listDecisionMakerStaleCloseCandidates(
  client: LedgerReader,
  input: { limit: number },
): Promise<string[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT r."id"
    FROM "AmuxDecisionMakerRequest" r
    WHERE r."route" = 'dm_proposal'
      AND r."createdAt" <= clock_timestamp() - ${DM_STALE_CLOSE_AFTER_MS} * INTERVAL '1 millisecond'
      AND NOT EXISTS (
        SELECT 1 FROM "AmuxDecisionMakerRequestEvent" ev
        WHERE ev."requestId" = r."id"
          AND ev."kind" IN ('assign_discarded', 'stale_close', 'confirm', 'edit_confirm', 'reject')
      )
    ORDER BY r."createdAt", r."id"
    LIMIT ${input.limit}
  `;
  return rows.map((row) => requireRequestId(row.id));
}

/**
 * The newest requests, newest first, at most `limit` (1 to 100) -- or the one
 * request `requestId` names -- with what their events add up to and the
 * database clock, in one statement: the
 * ledger's half of Admin's request list (stage S2,
 * lib/amux/decisionMakerAdminRead.ts, which joins the result detail and the
 * judgment and delivery halves read by their own stores in the same
 * REPEATABLE READ boundary and checks the joined row). The newest requests
 * are chosen first and only those are aggregated, so the cost does not grow
 * with the ledger. The clock row is joined to the requests, so an empty
 * ledger still returns the database clock. The closing kinds are the same
 * list the state read, the open count and the stale candidates use.
 */
export async function readRecentDecisionMakerRequestLedger(
  client: LedgerReader,
  input: { limit: number; requestId?: undefined } | { requestId: string; limit?: undefined },
): Promise<{ dbNowMs: number; rows: Array<Record<string, unknown>> }> {
  const requestId = input.requestId ?? null;
  const limit = requestId === null ? input.limit : 1;
  if (requestId !== null ? !isDmRequestId(requestId) : !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const rows = await client.$queryRaw<Array<Record<string, unknown>>>`
    WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS "now"),
    recent AS MATERIALIZED (
      SELECT * FROM "AmuxDecisionMakerRequest"
      WHERE ${requestId}::text IS NULL OR "id" = ${requestId}::text
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${limit}
    )
    SELECT
      r."id", r."cardId", r."questionRevision", r."askingWorkerId", r."askingProvider", r."route",
      r."instance", r."refusalCodes",
      floor(extract(epoch FROM r."createdAt") * 1000)::bigint AS "createdAtEpochMs",
      floor(extract(epoch FROM r."assignmentDeadlineAt") * 1000)::bigint AS "assignmentDeadlineAtEpochMs",
      floor(extract(epoch FROM db_clock."now") * 1000)::bigint AS "dbNowEpochMs",
      e."assigned", e."snapshotState", e."transmitOutcome", e."resultKind", e."resultUnknown", e."closingKind"
    FROM db_clock
    LEFT JOIN recent r ON true
    CROSS JOIN LATERAL (
      SELECT
        coalesce(bool_or(ev."kind" = 'assign'), false) AS "assigned",
        max(ev."snapshotState") FILTER (WHERE ev."kind" = 'transmit_intent') AS "snapshotState",
        max(ev."kind") FILTER (WHERE ev."kind" IN ('transmit_receipt', 'transmit_unknown')) AS "transmitOutcome",
        max(ev."resultKind") FILTER (WHERE ev."kind" = 'result') AS "resultKind",
        coalesce(bool_or(ev."kind" = 'result_unknown'), false) AS "resultUnknown",
        max(ev."kind") FILTER (
          WHERE ev."kind" IN ('assign_discarded', 'stale_close', 'confirm', 'edit_confirm', 'reject')
        ) AS "closingKind"
      FROM "AmuxDecisionMakerRequestEvent" ev
      WHERE ev."requestId" = r."id"
    ) e
    ORDER BY r."createdAt" DESC NULLS LAST, r."id" DESC
  `;
  const first = rows[0];
  if (!first) throw new Error("AMUX Decision Maker recent request read returned no row");
  const dbNowMs = safeInteger(first.dbNowEpochMs, "clock");
  // An empty ledger is the clock's row alone, with no request on it.
  return { dbNowMs, rows: rows.length === 1 && first.id === null ? [] : rows };
}

export type DecisionMakerProposalTimeline = {
  /** The database clock when the timeline was read. */
  dbNowMs: number;
  instances: Array<{
    instance: DmInstanceScope;
    /** Terminal results of kind proposal the instance's requests recorded. */
    proposals: number;
    /** The database clock of the instance's first proposal; null before it has one. */
    firstProposalAtMs: number | null;
  }>;
};

/**
 * Each DM instance's proposals and the database clock of its first, in one
 * statement, with the database clock: the ledger half of the declaration
 * accuracy report (docs/policy/amux-decision-maker.md §4: "첫 제안 뒤
 * 일수"). An instance with no proposal yet is listed with none. Reads only.
 */
export async function readDecisionMakerProposalTimeline(client: LedgerReader): Promise<DecisionMakerProposalTimeline> {
  const rows = await client.$queryRaw<
    Array<{
      dbNowEpochMs: bigint | number;
      instance: string;
      proposals: bigint | number;
      firstProposalAtEpochMs: bigint | number | null;
    }>
  >`
    WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS "now")
    SELECT
      floor(extract(epoch FROM db_clock."now") * 1000)::bigint AS "dbNowEpochMs",
      i."instance",
      count(ev."id") AS "proposals",
      floor(extract(epoch FROM min(ev."createdAt")) * 1000)::bigint AS "firstProposalAtEpochMs"
    FROM db_clock
    CROSS JOIN unnest(${[...DM_INSTANCE_SCOPES]}::text[]) AS i("instance")
    LEFT JOIN "AmuxDecisionMakerRequest" r ON r."instance" = i."instance"
    LEFT JOIN "AmuxDecisionMakerRequestEvent" ev
      ON ev."requestId" = r."id" AND ev."kind" = 'result' AND ev."resultKind" = 'proposal'
    GROUP BY db_clock."now", i."instance"
    ORDER BY i."instance"
  `;
  if (rows.length !== DM_INSTANCE_SCOPES.length) {
    throw new DecisionMakerRequestWriteError("state_unreadable");
  }
  const dbNowMs = safeInteger(rows[0]!.dbNowEpochMs, "clock");
  return {
    dbNowMs,
    instances: rows.map((row) => {
      if (!isDmInstanceScope(row.instance)) throw new DecisionMakerRequestWriteError("state_unreadable");
      return {
        instance: row.instance,
        proposals: safeInteger(row.proposals, "count"),
        firstProposalAtMs: row.firstProposalAtEpochMs === null ? null : safeInteger(row.firstProposalAtEpochMs, "clock"),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type DecisionMakerRequestRecord = {
  requestId: string;
  /** False when this (card, question revision) already had a request (§9). */
  created: boolean;
  route: DmRequestRoute;
  instance: DmInstanceScope | null;
  /** The router's refusals, in its order; empty for a proposal. */
  refusalCodes: string[];
  /** On an existing request, whether its stored binding equals the one given now. */
  sameBinding: boolean;
  createdAt: string;
  assignmentDeadlineAt: string;
  /**
   * The router's `amux.decision.route` audit this call wrote with a new
   * request -- the row a `card_text` body of the same transaction is bound
   * to (lib/amux/decisionMakerBodyStore.ts). Null for an existing request.
   */
  routeAuditLogId: string | null;
};

/** The routing read: the database clock, and the request of this card revision when there is one. */
type ExistingRequestRow = Record<string, unknown> & {
  dbNowEpochMs: bigint | number;
  id: string | null;
  route: string | null;
  instance: string | null;
  optionSetDigest: string | null;
  refusalCodes: unknown;
  createdAtEpochMs: bigint | number | null;
  assignmentDeadlineAtEpochMs: bigint | number | null;
};

/**
 * Routes one typed ask and records it (§2-2, §3, §9), in the caller's
 * transaction, in this order: the audit chain lock; the request already
 * recorded for this (card, question revision), if any -- returned as it is,
 * since a request is one per question revision and the first stands; the
 * switches, by the switch store's reader; the instance's throughput, when the
 * provider has an instance; `routeDmQuestion()` on those reads and the card;
 * and the router's `amux.decision.route` audit and the request naming it. The
 * database sets `createdAt` and the assignment deadline (creation + 2 min)
 * from its clock, and refuses a `dm_proposal` row the switches do not allow.
 *
 * The decision is made here, on reads taken after the lock that every switch
 * change and every other routing also takes, so neither a stale switch nor a
 * concurrent routing of the same instance can let a question through. The
 * card is not stored here: the application routes only through
 * `recordDecisionMakerRequestWithCardText()` in
 * lib/amux/decisionMakerBodyStore.ts, the body table's one writer, which calls
 * this and then stores the card text of a new request routed to a DM in the
 * same transaction under `routeAuditLogId` (§10, added 2026-10-09).
 * tests/amuxDecisionMakerBody.test.mjs fails on any other caller.
 *
 * The option set digest of §9's binding is the store's own (stage S1d,
 * 2026-10-08), never the caller's: an HMAC under the new request's key K_R
 * (lib/amux/decisionMakerBodyCore.ts) of the card's options, the key period
 * taken from the database clock read after the lock. The period of the row's
 * `createdAt` -- which every later digest of the request uses -- is checked
 * against it after the insert; on the rare routing that crosses a period
 * boundary in between, the store throws `key_period_changed` and the caller
 * routes again. Without the period's key in the ring nothing is written
 * (`digest_key_unavailable`), and the question stays with the operator as a
 * route failure does (§2-1). For an existing request `sameBinding` also
 * compares the option set, recomputed under that request's own key (false
 * when the ring no longer holds it).
 *
 * A switch read that fails throws `settings_unreadable` and writes nothing:
 * the read has aborted the transaction, and the question stays with the
 * operator as a route failure does (§2-1). Rows the switch store could not
 * have written are still recorded as `settings_unreadable`.
 *
 * §8 (2026-10-17): an instance whose latch is owed -- three validation
 * failures in a row since its newest switch event, not yet latched -- is
 * routed as off (`instance_off`), so no question reaches it in the time
 * between its third failure and its latch. The result kinds ride in the
 * throughput statement. A result kind the ledger could not hold throws
 * `state_unreadable` and writes nothing. §5 (stage S2-2a3): so is an instance
 * whose newest `cleanup_unknown` report has no `cleanup_latch` at or after
 * it, between the report and its latch -- a person's mode change in between
 * does not settle it (review r-20261017-115136-888d76); the report's clock
 * rides in the throughput statement and the latch's in the switch read.
 *
 * Statements: 1 lock, 1 read (the clock and any request of the card revision)
 * -- 2 for an existing request or a key the ring lacks; then the switch read
 * -- 3 when it fails; then the throughput and result read (none for a provider
 * without an instance), the system writer's 3 (4 with an integrity key) and 1
 * insert -- 8, or 9 (7, or 8, without an instance). The body store's card text
 * adds 1 to a new request routed to a DM.
 */
export async function recordDecisionMakerRequest(
  tx: Prisma.TransactionClient,
  input: { binding: unknown; card: unknown; keyRing: DmDigestKeyRing },
): Promise<DecisionMakerRequestRecord> {
  const binding = parseDmRoutingBinding(input.binding);
  const card = parseDmCard(input.card);
  if (!binding || !card || !(input.keyRing instanceof Map)) throw new DecisionMakerRequestWriteError("invalid_input");

  await takeAuditChainLock(tx);
  const read = await tx.$queryRaw<ExistingRequestRow[]>`
    SELECT
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowEpochMs",
      r."id", r."cardId", r."questionRevision", r."askingWorkerId", r."amuxSessionId", r."amuxSessionAttempt",
      r."askingProvider", r."optionSetDigest", r."termListVersion", r."classificationVersion", r."scannerVersion",
      r."route", r."instance", r."refusalCodes",
      floor(extract(epoch FROM r."createdAt") * 1000)::bigint AS "createdAtEpochMs",
      floor(extract(epoch FROM r."assignmentDeadlineAt") * 1000)::bigint AS "assignmentDeadlineAtEpochMs"
    FROM (SELECT 1) AS "probe"
    LEFT JOIN "AmuxDecisionMakerRequest" r
      ON r."cardId" = ${binding.cardId} AND r."questionRevision" = ${binding.questionRevision}
  `;
  const found = read[0];
  if (!found) throw new Error("AMUX Decision Maker routing read returned no row");
  if (found.id !== null) {
    if (
      (found.route !== "operator" && found.route !== "dm_proposal") ||
      (found.instance !== null && !isDmInstanceScope(found.instance)) ||
      !Array.isArray(found.refusalCodes) ||
      !found.refusalCodes.every((code) => typeof code === "string")
    ) {
      throw new DecisionMakerRequestWriteError("state_unreadable");
    }
    const foundCreatedAtMs = safeInteger(found.createdAtEpochMs, "clock");
    const foundKey = decisionMakerPeriodKey(input.keyRing, dmKeyPeriodOf(foundCreatedAtMs));
    const sameOptions =
      foundKey !== null &&
      found.optionSetDigest === dmOptionSetDigest(dmRequestDigestKey(foundKey, found.id), card.options);
    return {
      requestId: found.id,
      created: false,
      route: found.route,
      instance: found.instance as DmInstanceScope | null,
      refusalCodes: [...(found.refusalCodes as string[])],
      sameBinding: sameOptions && DM_ROUTING_BINDING_KEYS.every((key) => found[key] === binding[key]),
      createdAt: isoOf(foundCreatedAtMs),
      assignmentDeadlineAt: isoOf(safeInteger(found.assignmentDeadlineAtEpochMs, "clock")),
      routeAuditLogId: null,
    };
  }
  const keyPeriod = dmKeyPeriodOf(safeInteger(found.dbNowEpochMs, "clock"));
  const periodKey = decisionMakerPeriodKey(input.keyRing, keyPeriod);
  if (!periodKey) throw new DecisionMakerRequestWriteError("digest_key_unavailable");

  const switches = await readSwitchesForWrite(tx);
  const instance = dmInstanceForProvider(binding.askingProvider);
  let throughput = { lastHour: 0, lastDay: 0 };
  let routingSwitches = dmSwitchRoutingInput(switches.state, instance);
  if (isDmInstanceScope(instance)) {
    const load = await readDecisionMakerInstanceLoad(tx, {
      instance,
      sinceMs: switches.newest[instance]?.createdAtMs ?? null,
    });
    throughput = { lastHour: load.lastHour, lastDay: load.lastDay };
    // §5, §8: an owed latch is the instance off -- the question goes to the operator.
    routingSwitches = dmSwitchInputWithOwedLatch(routingSwitches, owedLatch(switches, instance, load) !== null);
  }
  const decision = routeDmQuestion({
    ...routingSwitches,
    card,
    askingProvider: binding.askingProvider,
    throughput,
  });
  const requestId = randomUUID();
  const optionSetDigest = dmOptionSetDigest(dmRequestDigestKey(periodKey, requestId), card.options);
  const record = parseDmRequestRecord({ ...binding, optionSetDigest }, decision);
  if (!record) throw new Error("AMUX Decision Maker routing produced a decision the ledger refuses");

  const auditLogId = await writeDecisionMakerRouteAudit(tx, {
    requestId,
    metadata: dmRequestAuditMetadata({
      requestId,
      route: record.route,
      instance: record.instance,
      askingProvider: record.askingProvider,
      refusalCodes: record.refusalCodes,
    }),
  });
  const inserted = await tx.$queryRaw<Array<{ createdAtEpochMs: bigint | number; assignmentDeadlineAtEpochMs: bigint | number }>>`
    INSERT INTO "AmuxDecisionMakerRequest"
      ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
       "askingProvider", "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion",
       "scannerVersion", "route", "instance", "refusalCodes", "auditLogId")
    VALUES
      (${requestId}, ${record.cardId}, ${record.questionRevision}, ${record.askingWorkerId},
       ${record.amuxSessionId}, ${record.amuxSessionAttempt}, ${record.askingProvider},
       ${record.optionSetDigest}, ${record.policyVersion}, ${record.termListVersion},
       ${record.classificationVersion}, ${record.scannerVersion}, ${record.route}, ${record.instance},
       ${record.refusalCodes}::text[], ${auditLogId})
    RETURNING
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs",
      floor(extract(epoch FROM "assignmentDeadlineAt") * 1000)::bigint AS "assignmentDeadlineAtEpochMs"
  `;
  const row = inserted[0];
  if (!row) throw new Error("AMUX Decision Maker request insert returned no row");
  const createdAtMs = safeInteger(row.createdAtEpochMs, "clock");
  // The digest was keyed by the period of the clock read above; the request's
  // own period, which every later digest uses, must be the same.
  if (dmKeyPeriodOf(createdAtMs) !== keyPeriod) throw new DecisionMakerRequestWriteError("key_period_changed");
  return {
    requestId,
    created: true,
    route: record.route,
    instance: record.instance,
    refusalCodes: [...record.refusalCodes],
    sameBinding: true,
    createdAt: isoOf(createdAtMs),
    assignmentDeadlineAt: isoOf(safeInteger(row.assignmentDeadlineAtEpochMs, "clock")),
    routeAuditLogId: auditLogId,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type DecisionMakerEventRecord = {
  eventId: string;
  auditLogId: string;
  /** The database's sequence, as a decimal string (it is a BIGINT). */
  sequence: string;
  createdAt: string;
  /** Set on an assignment only: its database clock plus 30 minutes. */
  resultDeadlineAt: string | null;
};

export type DecisionMakerEventWrite =
  | { recorded: true; event: DecisionMakerEventRecord }
  | { recorded: false; reason: DmEventRefusal | "unknown_request" };

type EventColumns = {
  kind: DmEventAttempt["kind"];
  instance: DmInstanceScope | null;
  vendor: string | null;
  inputPayloadDigest: string | null;
  snapshotState: string | null;
  snapshotTargetSha: string | null;
  snapshotManifestDigest: string | null;
  resultKind: DmResultKind | null;
  resultDigest: string | null;
  rejectionReason: DmResultRejectionReason | null;
};

const NO_COLUMNS = {
  instance: null,
  vendor: null,
  inputPayloadDigest: null,
  snapshotState: null,
  snapshotTargetSha: null,
  snapshotManifestDigest: null,
  resultKind: null,
  resultDigest: null,
  rejectionReason: null,
} as const;

type InsertedEventRow = {
  sequence: bigint | number | string;
  createdAtEpochMs: bigint | number;
  resultDeadlineAtEpochMs: bigint | number | null;
};

/** The audit chain lock, then the state read. 2 statements. */
const lockAndRead = async (
  tx: Prisma.TransactionClient,
  requestId: string,
  probeDigest: string | null = null,
): Promise<DmRequestState | null> => {
  await takeAuditChainLock(tx);
  return readDecisionMakerRequestState(tx, requestId, probeDigest);
};

/** The event's system audit, then the event naming it. 4 statements, or 5 with an integrity key. */
const appendEvent = async (
  tx: Prisma.TransactionClient,
  requestId: string,
  columns: EventColumns,
): Promise<DecisionMakerEventRecord> => {
  const eventId = randomUUID();
  const auditLogId = await writeDecisionMakerEventAudit(tx, {
    kind: columns.kind,
    instance: columns.instance,
    eventId,
    metadata: dmEventAuditMetadata({
      event_id: eventId,
      request_id: requestId,
      kind: columns.kind,
      instance: columns.instance,
      vendor: columns.vendor,
      snapshot_state: columns.snapshotState,
      result_kind: columns.resultKind,
      rejection_reason: columns.rejectionReason,
    }),
  });
  const inserted = await tx.$queryRaw<InsertedEventRow[]>`
    INSERT INTO "AmuxDecisionMakerRequestEvent"
      ("id", "requestId", "kind", "instance", "vendor", "inputPayloadDigest", "snapshotState",
       "snapshotTargetSha", "snapshotManifestDigest", "resultKind", "resultDigest", "rejectionReason",
       "auditLogId")
    VALUES
      (${eventId}, ${requestId}, ${columns.kind}, ${columns.instance}, ${columns.vendor},
       ${columns.inputPayloadDigest}, ${columns.snapshotState}, ${columns.snapshotTargetSha},
       ${columns.snapshotManifestDigest}, ${columns.resultKind}, ${columns.resultDigest},
       ${columns.rejectionReason}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs",
      floor(extract(epoch FROM "resultDeadlineAt") * 1000)::bigint AS "resultDeadlineAtEpochMs"
  `;
  const row = inserted[0];
  if (!row) throw new Error("AMUX Decision Maker request event insert returned no row");
  return {
    eventId,
    auditLogId,
    sequence: String(row.sequence),
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
    resultDeadlineAt:
      row.resultDeadlineAtEpochMs === null ? null : isoOf(safeInteger(row.resultDeadlineAtEpochMs, "clock")),
  };
};

const requireRequestId = (requestId: unknown): string => {
  if (!isDmRequestId(requestId)) throw new DecisionMakerRequestWriteError("invalid_input");
  return requestId;
};

const requireInstance = (instance: unknown): DmInstanceScope => {
  if (!isDmInstanceScope(instance)) throw new DecisionMakerRequestWriteError("invalid_input");
  return instance;
};

/**
 * §2-1, §9: the router hands the request's assignment to the local AMUX, once,
 * and only before the assignment deadline by the database clock. The deadline
 * is given to `requireLeaseAt`, so the commit fence refuses at it less the
 * commit reserve. A second assignment is refused (`already_assigned`); it is
 * never handed out again.
 *
 * Statements: 2 for a refusal; 6, or 7 with an integrity key, for an assignment.
 */
export async function assignDecisionMakerRequest(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown; requireLeaseAt: (deadline: Date) => void },
): Promise<DecisionMakerEventWrite> {
  const requestId = requireRequestId(input.requestId);
  if (typeof input.requireLeaseAt !== "function") throw new DecisionMakerRequestWriteError("invalid_input");
  const state = await lockAndRead(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const refusal = dmEventRefusal(state, { kind: "assign" });
  if (refusal) return { recorded: false, reason: refusal };
  input.requireLeaseAt(new Date(state.assignmentDeadlineAtMs));
  return { recorded: true, event: await appendEvent(tx, requestId, { kind: "assign", ...NO_COLUMNS }) };
}

/**
 * §2-3: the local AMUX could not mark the card, so it discards the assignment
 * and the request closes. Statements: 2 for a refusal; 6, or 7.
 */
export async function discardDecisionMakerAssignment(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown },
): Promise<DecisionMakerEventWrite> {
  const requestId = requireRequestId(input.requestId);
  const state = await lockAndRead(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const refusal = dmEventRefusal(state, { kind: "assign_discarded" });
  if (refusal) return { recorded: false, reason: refusal };
  return { recorded: true, event: await appendEvent(tx, requestId, { kind: "assign_discarded", ...NO_COLUMNS }) };
}

/**
 * §2-4, §10: the broker's transmission intent, recorded before any DM process
 * starts -- the instance, its vendor, the input payload digest and the
 * snapshot (state, target SHA and manifest digest, the last two only when the
 * state is not `none`). One per request; the broker starts the process only
 * on a recorded intent, and the card is never sent again.
 *
 * The switches are read here, after the lock: with the kill switch on, the
 * instance `off`, or the switch store unreadable, nothing is written and no
 * process may start (§6, §8). A switch read that fails throws
 * `settings_unreadable` (the transaction is aborted and rolls back); rows
 * the store could not have written return the refusal. The result deadline is
 * given to `requireLeaseAt`, and the database refuses an intent whose COMMIT
 * reaches it, as it does a late DM output.
 *
 * §8 (2026-10-17): with the instance in proposal mode, its terminal results
 * since its newest switch event are read too. When three validation failures
 * in a row stand there with no latch since, the latch is owed: no intent is
 * recorded, the refusal is `instance_off`, and the owed latch is written in
 * this transaction (`validation_latch`, under the instance's own actor) -- the
 * one refusal of this function that writes, and only that latch. A result
 * kind the ledger could not hold throws `state_unreadable` and writes nothing.
 * §5 (stage S2-2a3): the same statement reads the instance's newest
 * `cleanup_unknown` report, and a report with no `cleanup_latch` at or after
 * it (the switch read's clock; a person's mode change does not settle it)
 * owes `cleanup_latch`, which is refused and written the same way -- in
 * place of the validation latch when both are owed (`dmOwedLatchReason()`).
 *
 * Statements: 1 lock, 1 state read -- 2 for an unknown request or a ledger
 * refusal; then the switch read -- 3 for a switch refusal or a failed read;
 * then the result and report read -- 4; then either the owed latch's 4 (5
 * with an integrity key) or the system writer's 3 (4) and 1 insert -- 8, or 9.
 */
export async function recordDecisionMakerTransmitIntent(
  tx: Prisma.TransactionClient,
  input: {
    requestId: unknown;
    instance: unknown;
    transmission: unknown;
    requireLeaseAt: (deadline: Date) => void;
  },
): Promise<
  | DecisionMakerEventWrite
  | { recorded: false; reason: DmTransmitSwitchRefusal; latch?: DecisionMakerSwitchEventRecord }
> {
  const requestId = requireRequestId(input.requestId);
  const instance = requireInstance(input.instance);
  const transmission = parseDmTransmission(input.transmission);
  if (!transmission || typeof input.requireLeaseAt !== "function") {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const state = await lockAndRead(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const refusal = dmEventRefusal(state, { kind: "transmit_intent", instance });
  if (refusal) return { recorded: false, reason: refusal };
  const switches = await readSwitchesForWrite(tx);
  const switchRefusal = dmTransmitSwitchRefusal(dmSwitchRoutingInput(switches.state, instance));
  if (switchRefusal) return { recorded: false, reason: switchRefusal };
  const latchInputs = await readDecisionMakerInstanceLatchInputs(tx, {
    instance,
    sinceMs: switches.newest[instance]?.createdAtMs ?? null,
  });
  const owed = owedLatch(switches, instance, latchInputs);
  if (owed !== null) {
    const latch = await latchDecisionMakerInstanceOff(tx, { instance, reason: owed });
    return { recorded: false, reason: "instance_off", latch };
  }
  if (state.resultDeadlineAtMs === null) throw new DecisionMakerRequestWriteError("state_unreadable");
  input.requireLeaseAt(new Date(state.resultDeadlineAtMs));
  return {
    recorded: true,
    event: await appendEvent(tx, requestId, {
      ...NO_COLUMNS,
      kind: "transmit_intent",
      instance,
      vendor: DM_VENDOR_FOR_INSTANCE[instance],
      inputPayloadDigest: transmission.inputPayloadDigest,
      snapshotState: transmission.snapshotState,
      snapshotTargetSha: transmission.snapshotTargetSha,
      snapshotManifestDigest: transmission.snapshotManifestDigest,
    }),
  };
}

/**
 * §10: the broker's receipt once the process ended, or `unknown` when it
 * cannot say -- counted as sent either way, and never sent again. One of the
 * two per request, accepted even after the request closed.
 * Statements: 2 for a refusal; 6, or 7.
 */
export async function recordDecisionMakerTransmitOutcome(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown; instance: unknown; outcome: unknown },
): Promise<DecisionMakerEventWrite> {
  const requestId = requireRequestId(input.requestId);
  const instance = requireInstance(input.instance);
  if (input.outcome !== "receipt" && input.outcome !== "unknown") {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const kind = input.outcome === "receipt" ? "transmit_receipt" : "transmit_unknown";
  const state = await lockAndRead(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const refusal = dmEventRefusal(state, { kind, instance });
  if (refusal) return { recorded: false, reason: refusal };
  return { recorded: true, event: await appendEvent(tx, requestId, { ...NO_COLUMNS, kind, instance }) };
}

export type DecisionMakerResultSubmission =
  | { status: "accepted"; event: DecisionMakerEventRecord; resultKind: DmResultKind }
  | { status: "existing"; eventId: string; resultKind: DmResultKind }
  | { status: "rejected"; event: DecisionMakerEventRecord; reason: DmResultRejectionReason }
  | { status: "already_rejected"; reason: DmResultRejectionReason }
  | { status: "unknown_request" }
  | { status: "instance_mismatch" };

/**
 * §6, §9: a terminal result -- proposal, escalation, validation failure,
 * timeout or DM unavailable -- submitted with its result digest.
 *
 * Idempotent on the (request, digest) pair: the pair of the recorded result
 * returns it, the pair of a recorded rejection returns that, and neither
 * writes. Any other submission is recorded, either as the request's one
 * terminal result or as a rejection with its reason
 * (`dmResultSubmissionOutcome()`): a different digest after a result, a
 * closed request, a binding value that changed, a DM output at its deadline
 * less the reserve, and a proposal while the kill switch is on.
 *
 * The kill switch is read here, after the lock, never taken from the caller
 * (§6's table: "진행 중 결과의 제안 저장 — 거부"); an unreadable switch store
 * writes nothing and throws `settings_unreadable`. A DM output's result
 * deadline is given to `requireLeaseAt`, so the commit fence and, at COMMIT,
 * the database refuse a late one.
 *
 * Statements: 1 lock, 1 state read -- 2 when nothing is written (an existing
 * pair, an unknown request, another instance); then the switch read -- 3 when
 * it is unreadable; then the system writer's 3 (4 with an integrity key) and 1
 * insert -- 7, or 8, for a result or a rejection.
 */
export async function submitDecisionMakerResult(
  tx: Prisma.TransactionClient,
  input: {
    requestId: unknown;
    submission: unknown;
    requireLeaseAt: (deadline: Date) => void;
  },
): Promise<DecisionMakerResultSubmission> {
  const requestId = requireRequestId(input.requestId);
  const submission = parseDmResultSubmission(input.submission);
  if (!submission || typeof input.requireLeaseAt !== "function") {
    throw new DecisionMakerRequestWriteError("invalid_input");
  }
  const state = await lockAndRead(tx, requestId, submission.resultDigest);
  if (!state) return { status: "unknown_request" };
  // Nothing can be recorded for another instance: the trigger binds every
  // result event to the request's own.
  if (state.instance !== submission.instance) return { status: "instance_mismatch" };
  const recorded = dmResultLookup(state, submission.resultDigest);
  if (recorded.status === "accepted") {
    return { status: "existing", eventId: recorded.eventId, resultKind: recorded.resultKind };
  }
  if (recorded.status === "rejected") return { status: "already_rejected", reason: recorded.reason };

  const { killSwitch } = (await readSwitchesForWrite(tx)).state;
  if (killSwitch === null) throw new DecisionMakerRequestWriteError("settings_unreadable");
  const decision = dmResultSubmissionOutcome(state, submission, killSwitch);
  switch (decision.outcome) {
    case "existing_result":
    case "existing_rejection":
      throw new Error("AMUX Decision Maker result pair was settled before the switch read");
    case "reject": {
      const event = await appendEvent(tx, requestId, {
        ...NO_COLUMNS,
        kind: "result_rejected",
        instance: submission.instance,
        resultDigest: submission.resultDigest,
        rejectionReason: decision.reason,
      });
      return { status: "rejected", event, reason: decision.reason };
    }
    case "accept": {
      if (isDmDeadlineResultKind(submission.resultKind)) {
        if (state.resultDeadlineAtMs === null) throw new DecisionMakerRequestWriteError("state_unreadable");
        input.requireLeaseAt(new Date(state.resultDeadlineAtMs));
      }
      const event = await appendEvent(tx, requestId, {
        ...NO_COLUMNS,
        kind: "result",
        instance: submission.instance,
        inputPayloadDigest: state.transmission?.inputPayloadDigest ?? null,
        resultKind: submission.resultKind,
        resultDigest: submission.resultDigest,
      });
      return { status: "accepted", event, resultKind: submission.resultKind };
    }
  }
}

export type DecisionMakerResultUnknownWrite =
  | DecisionMakerEventWrite
  | { recorded: false; reason: "already_accepted" | "already_rejected" };

/**
 * §9: a submitter that lost the response to a result and could not confirm it
 * by the (request, digest) pair records the result as unknown; the request
 * then goes to the operator and no later result is accepted for it. A pair
 * the ledger already accepted or rejected is reported as such instead.
 * Statements: 2 when nothing is written; 6, or 7.
 */
export async function recordDecisionMakerResultUnknown(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown; instance: unknown; resultDigest: unknown },
): Promise<DecisionMakerResultUnknownWrite> {
  const requestId = requireRequestId(input.requestId);
  const instance = requireInstance(input.instance);
  if (!isDmDigest(input.resultDigest)) throw new DecisionMakerRequestWriteError("invalid_input");
  const resultDigest = input.resultDigest;
  const state = await lockAndRead(tx, requestId, resultDigest);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const lookup = dmResultLookup(state, resultDigest);
  if (lookup.status === "accepted") return { recorded: false, reason: "already_accepted" };
  if (lookup.status === "rejected") return { recorded: false, reason: "already_rejected" };
  const refusal = dmEventRefusal(state, { kind: "result_unknown", instance, resultDigest });
  if (refusal) return { recorded: false, reason: refusal };
  return {
    recorded: true,
    event: await appendEvent(tx, requestId, { ...NO_COLUMNS, kind: "result_unknown", instance, resultDigest }),
  };
}

/**
 * §10: an open request is closed 30 days after it was created, by the
 * database clock. Statements: 2 for a refusal; 6, or 7.
 */
export async function staleCloseDecisionMakerRequest(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown },
): Promise<DecisionMakerEventWrite> {
  const requestId = requireRequestId(input.requestId);
  const state = await lockAndRead(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const refusal = dmEventRefusal(state, { kind: "stale_close" });
  if (refusal) return { recorded: false, reason: refusal };
  return { recorded: true, event: await appendEvent(tx, requestId, { kind: "stale_close", ...NO_COLUMNS }) };
}

// ---------------------------------------------------------------------------
// §5's cleanup report (stage S2-2a3)
// ---------------------------------------------------------------------------

export type DecisionMakerCleanupUnknownWrite =
  | { status: "recorded"; event: DecisionMakerEventRecord }
  | { status: "existing"; eventId: string; createdAt: string }
  | { status: "refused"; reason: DmEventRefusal | "unknown_request" };

/**
 * §5: "지웠는지 확인하지 못하면 cleanup_unknown으로 두고" -- the broker could
 * not confirm that a request's directory and its vendor account's scratch
 * directory were deleted, and reports it for the request's own instance. The
 * request gets its `cleanup_unknown` event under the instance's
 * `amux.decision.cleanup_unknown` audit, in the caller's transaction: the
 * audit chain lock, the request's state, then the audit and the event.
 *
 * Once per request (§10's partial unique index, and the event guard). A
 * report sent again -- after a lost response, or after the operator released
 * the latch it caused -- writes nothing and returns the event already
 * recorded: foundation principle 7, an unknown outcome is settled by a read,
 * never by a second write. Another instance's report is refused before the
 * existing one is looked at, so it learns nothing about the request.
 *
 * The event closes nothing and holds no deadline; it is accepted after the
 * request closed or its result arrived, and under the kill switch, because
 * the files it reports on exist or not whatever the ledger says. It needs the
 * assignment: the broker builds a request directory only for an assigned
 * request.
 *
 * The latch is not written here: the caller writes it in a transaction of its
 * own once this commits (`recordDecisionMakerCleanupLatch()`), and until then
 * a routing and a transmission intent refuse the instance as owed.
 *
 * Statements: 1 lock, 1 state read -- 2 for an unknown request, a refusal or a
 * report already recorded; then the instance's audit 3 (4 with an integrity
 * key) and 1 insert -- 6, or 7.
 */
export async function recordDecisionMakerCleanupUnknown(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown; instance: unknown },
): Promise<DecisionMakerCleanupUnknownWrite> {
  const requestId = requireRequestId(input.requestId);
  const instance = requireInstance(input.instance);
  const state = await lockAndRead(tx, requestId);
  if (!state) return { status: "refused", reason: "unknown_request" };
  if (state.instance !== instance) return { status: "refused", reason: "instance_mismatch" };
  if (state.cleanupUnknown !== null) {
    return {
      status: "existing",
      eventId: state.cleanupUnknown.eventId,
      createdAt: isoOf(state.cleanupUnknown.createdAtMs),
    };
  }
  const refusal = dmEventRefusal(state, { kind: "cleanup_unknown", instance });
  if (refusal) return { status: "refused", reason: refusal };
  return {
    status: "recorded",
    event: await appendEvent(tx, requestId, { ...NO_COLUMNS, kind: "cleanup_unknown", instance }),
  };
}

// ---------------------------------------------------------------------------
// §8's validation latch
// ---------------------------------------------------------------------------

/**
 * The kinds of an instance's terminal results recorded at or after `sinceMs`
 * by the database clock -- every one when it is null -- newest first, at most
 * DM_VALIDATION_LATCH_WINDOW, in one statement: what §8's count reads
 * (`dmValidationLatchDecision()`). Every ledger write takes the audit chain
 * lock first, so the sequence is the order the results committed in. A result
 * event names its request's own instance, which the event guard requires.
 * The kinds are returned as read; the core refuses one outside §6's five.
 * The validation latch check reads it; a routing reads the same kinds inside
 * its throughput statement (`readDecisionMakerInstanceLoad()`), and since
 * stage S2-2a3 a transmission intent inside the statement that also reads the
 * newest cleanup report (`readDecisionMakerInstanceLatchInputs()`).
 */
export async function readDecisionMakerInstanceResultKinds(
  client: LedgerReader,
  input: { instance: DmInstanceScope; sinceMs: number | null },
): Promise<unknown[]> {
  if (!isDmInstanceScope(input.instance)) throw new DecisionMakerRequestWriteError("invalid_input");
  const sinceMs = requireSinceMs(input.sinceMs);
  const rows = await client.$queryRaw<Array<{ resultKind: unknown }>>`
    SELECT ev."resultKind"
    FROM "AmuxDecisionMakerRequestEvent" ev
    WHERE ev."kind" = 'result'
      AND ev."instance" = ${input.instance}
      AND ev."createdAt" >= 'epoch'::timestamptz + ${sinceMs} * INTERVAL '1 millisecond'
    ORDER BY ev."sequence" DESC
    LIMIT ${DM_VALIDATION_LATCH_WINDOW}
  `;
  return rows.map((row) => row.resultKind);
}

export type DecisionMakerValidationLatchWrite =
  | { latched: true; event: DecisionMakerSwitchEventRecord }
  | { latched: false; reason: Extract<DmValidationLatchDecision, { latch: false }>["reason"] };

/**
 * §8: latches `instance` off when three of its validation failures in a row
 * stand since its newest switch event (`dmValidationLatchDecision()`), in the
 * caller's transaction, in this order: the audit chain lock -- which every
 * switch change and every ledger write takes first, so no result and no
 * release commits between the reads and the latch, and two checks of one
 * instance cannot both latch; the switch read with each instance's newest
 * event; the instance's terminal results since that event's database clock;
 * and then the switch store's latch (`validation_latch`), under the
 * instance's own actor.
 *
 * A result and its switch boundary are compared by their database clocks,
 * which are milliseconds: a result in the same millisecond as the boundary is
 * counted, the side that latches sooner.
 *
 * Two callers, each in a boundary transaction of its own: the result route,
 * once a validation failure it recorded has committed
 * (app/api/internal/amux/decision-maker/results/route.ts), and the maintenance
 * sweep for both instances every fifteen minutes
 * (lib/amux/decisionMakerRetentionSweep.ts). Neither is what stops the
 * instance in the meantime: a routing and a transmission intent refuse an
 * owed latch themselves, and the intent writes it. A latch only turns an
 * instance off, which no row of §6's kill switch table refuses, so the kill
 * switch does not decide anything here.
 *
 * A switch event or a result the stores could not have written throws
 * `settings_unreadable` or `state_unreadable`, and nothing is written.
 *
 * Statements: 1 lock, 1 switch read, 1 result read -- 3 when nothing is due;
 * then the latch's 4 (5 with an integrity key) -- 7, or 8.
 */
export async function recordDecisionMakerValidationLatch(
  tx: Prisma.TransactionClient,
  input: { instance: unknown },
): Promise<DecisionMakerValidationLatchWrite> {
  const instance = requireInstance(input.instance);
  await takeAuditChainLock(tx);
  const switches = await readSwitchesForWrite(tx);
  if (switches.state.killSwitch === null) throw new DecisionMakerRequestWriteError("settings_unreadable");
  const newestEvent = switches.newest[instance];
  const resultKindsNewestFirst = await readDecisionMakerInstanceResultKinds(tx, {
    instance,
    sinceMs: newestEvent?.createdAtMs ?? null,
  });
  const decision = dmValidationLatchDecision({ newestEvent, resultKindsNewestFirst });
  if (decision === null) throw new DecisionMakerRequestWriteError("state_unreadable");
  if (!decision.latch) return { latched: false, reason: decision.reason };
  return { latched: true, event: await latchDecisionMakerInstanceOff(tx, { instance, reason: "validation_latch" }) };
}

// ---------------------------------------------------------------------------
// §5's cleanup latch (stage S2-2a3)
// ---------------------------------------------------------------------------

/**
 * What a transmission intent reads to know whether `instance` owes a latch,
 * in one statement: the kinds of its terminal results recorded at or after
 * `sinceMs` (as `readDecisionMakerInstanceResultKinds()`), and the database
 * clock of its newest `cleanup_unknown` report, null when it has none. The
 * report is read whatever its age; `dmCleanupLatchDecision()` compares it with
 * the newest switch event.
 */
export async function readDecisionMakerInstanceLatchInputs(
  client: LedgerReader,
  input: { instance: DmInstanceScope; sinceMs: number | null },
): Promise<{ resultKindsNewestFirst: unknown[]; newestCleanupUnknownAtMs: number | null }> {
  if (!isDmInstanceScope(input.instance)) throw new DecisionMakerRequestWriteError("invalid_input");
  const sinceMs = requireSinceMs(input.sinceMs);
  const rows = await client.$queryRaw<Array<{ resultKinds: unknown; newestCleanupUnknownAtEpochMs: unknown }>>`
    SELECT
      ARRAY(
        SELECT ev."resultKind"
        FROM "AmuxDecisionMakerRequestEvent" ev
        WHERE ev."kind" = 'result'
          AND ev."instance" = ${input.instance}
          AND ev."createdAt" >= 'epoch'::timestamptz + ${sinceMs} * INTERVAL '1 millisecond'
        ORDER BY ev."sequence" DESC
        LIMIT ${DM_VALIDATION_LATCH_WINDOW}
      ) AS "resultKinds",
      (
        SELECT floor(extract(epoch FROM max(c."createdAt")) * 1000)::bigint
        FROM "AmuxDecisionMakerRequestEvent" c
        WHERE c."kind" = 'cleanup_unknown'
          AND c."instance" = ${input.instance}
      ) AS "newestCleanupUnknownAtEpochMs"
  `;
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker latch input read returned no row");
  if (!Array.isArray(row.resultKinds)) throw new DecisionMakerRequestWriteError("state_unreadable");
  return {
    resultKindsNewestFirst: [...row.resultKinds],
    newestCleanupUnknownAtMs: newestReportClock(row.newestCleanupUnknownAtEpochMs),
  };
}

/**
 * The database clock of `instance`'s newest `cleanup_unknown` report, or null
 * when it has none, in one statement on the reports' own partial index: what
 * §5's latch check reads.
 */
export async function readDecisionMakerInstanceNewestCleanupUnknown(
  client: LedgerReader,
  input: { instance: DmInstanceScope },
): Promise<number | null> {
  if (!isDmInstanceScope(input.instance)) throw new DecisionMakerRequestWriteError("invalid_input");
  const rows = await client.$queryRaw<Array<{ newestCleanupUnknownAtEpochMs: unknown }>>`
    SELECT floor(extract(epoch FROM max(c."createdAt")) * 1000)::bigint AS "newestCleanupUnknownAtEpochMs"
    FROM "AmuxDecisionMakerRequestEvent" c
    WHERE c."kind" = 'cleanup_unknown'
      AND c."instance" = ${input.instance}
  `;
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker cleanup report read returned no row");
  return newestReportClock(row.newestCleanupUnknownAtEpochMs);
}

export type DecisionMakerCleanupLatchWrite =
  | { latched: true; event: DecisionMakerSwitchEventRecord }
  | { latched: false; reason: Extract<DmCleanupLatchDecision, { latch: false }>["reason"] };

/**
 * §5: latches `instance` off when its newest `cleanup_unknown` report has no
 * `cleanup_latch` at or after it (`dmCleanupLatchDecision()`), in the
 * caller's transaction, in this order: the audit chain lock -- which every
 * switch change and every ledger write takes first, so no report and no
 * latch commits between the reads and the latch, and two checks of one
 * instance cannot both latch; the switch read with each instance's newest
 * event and newest cleanup latch; the instance's newest report; and then the
 * switch store's latch (`cleanup_latch`), under the instance's own actor.
 *
 * Only the report's own latch settles it, so the same report never latches
 * twice: sent again, or sent again after the operator released the latch, it
 * is the same event, before that latch. A person's ordinary mode change
 * between the report and the latch -- the same mode saved again, off and back
 * -- does not settle it (review r-20261017-115136-888d76), and neither does a
 * latch of another cause: a second cause is a second record
 * (lib/amux/decisionMakerSwitchStore.ts).
 *
 * Two callers, each in a boundary transaction of its own: the cleanup route,
 * once a report has committed or was found already recorded
 * (app/api/internal/amux/decision-maker/cleanup/unknown/route.ts), and the
 * maintenance sweep for both instances every fifteen minutes
 * (lib/amux/decisionMakerRetentionSweep.ts). Neither is what stops the
 * instance in the meantime: a routing and a transmission intent refuse an
 * owed latch themselves, and the intent writes it. A latch only turns an
 * instance off, so the kill switch does not decide anything here.
 *
 * A switch event or a report clock the stores could not have written throws
 * `settings_unreadable` or `state_unreadable`, and nothing is written.
 *
 * Statements: 1 lock, 1 switch read, 1 report read -- 3 when nothing is due;
 * then the latch's 4 (5 with an integrity key) -- 7, or 8.
 */
export async function recordDecisionMakerCleanupLatch(
  tx: Prisma.TransactionClient,
  input: { instance: unknown },
): Promise<DecisionMakerCleanupLatchWrite> {
  const instance = requireInstance(input.instance);
  await takeAuditChainLock(tx);
  const switches = await readSwitchesForWrite(tx);
  if (switches.state.killSwitch === null) throw new DecisionMakerRequestWriteError("settings_unreadable");
  const newestCleanupUnknownAtMs = await readDecisionMakerInstanceNewestCleanupUnknown(tx, { instance });
  const decision = dmCleanupLatchDecision({
    cleanupLatchedAtMs: switches.cleanupLatchedAtMs[instance],
    newestCleanupUnknownAtMs,
  });
  if (decision === null) throw new DecisionMakerRequestWriteError("state_unreadable");
  if (!decision.latch) return { latched: false, reason: decision.reason };
  return { latched: true, event: await latchDecisionMakerInstanceOff(tx, { instance, reason: "cleanup_latch" }) };
}
