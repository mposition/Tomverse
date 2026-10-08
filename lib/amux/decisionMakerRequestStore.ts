import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { dmInstanceForProvider, routeDmQuestion } from "@/lib/amux/decisionMakerCore";
import {
  DM_REQUEST_BINDING_KEYS,
  DM_VENDOR_FOR_INSTANCE,
  dmEventAuditMetadata,
  dmEventRefusal,
  dmRequestAuditMetadata,
  dmRequestStateFromRow,
  dmTransmitSwitchRefusal,
  dmResultLookup,
  parseDmCard,
  dmResultSubmissionOutcome,
  isDmDeadlineResultKind,
  isDmDigest,
  isDmRequestId,
  parseDmRequestBinding,
  parseDmRequestRecord,
  parseDmResultSubmission,
  parseDmTransmission,
  type DmEventAttempt,
  type DmEventRefusal,
  type DmRequestRoute,
  type DmRequestState,
  type DmResultKind,
  type DmResultLookup,
  type DmResultRejectionReason,
  type DmTransmitSwitchRefusal,
} from "@/lib/amux/decisionMakerRequestCore";
import {
  writeDecisionMakerEventAudit,
  writeDecisionMakerRouteAudit,
} from "@/lib/amux/decisionMakerRequestSystemAudit";
import {
  dmSwitchRoutingInput,
  isDmInstanceScope,
  type DmInstanceScope,
} from "@/lib/amux/decisionMakerSwitchCore";
import { readDecisionMakerSwitches } from "@/lib/amux/decisionMakerSwitchStore";

/**
 * The one module that reads and writes `AmuxDecisionMakerRequest` and
 * `AmuxDecisionMakerRequestEvent` (docs/policy/amux-decision-maker.md §10:
 * "단일 writer 모듈이 위 표들에 쓴다"). Nothing else in the application names
 * either table; tests/amuxDecisionMakerRequest.test.mjs and `npm run
 * check:protected-table-writers` fail on another writer.
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
 * No card text, prompt, proposal or free text is written by it.
 */

type LedgerReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export class DecisionMakerRequestWriteError extends Error {
  readonly code: "invalid_input" | "state_unreadable";

  constructor(code: DecisionMakerRequestWriteError["code"]) {
    super(code);
    this.name = "DecisionMakerRequestWriteError";
    this.code = code;
  }
}

const safeInteger = (value: unknown, label: string): number => {
  const number = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`AMUX Decision Maker ledger ${label} is not a safe integer`);
  return number;
};

const isoOf = (epochMs: number) => new Date(epochMs).toISOString();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Requests routed to `instance` for a proposal in the trailing hour and day,
 * by the database clock, in one statement: the throughput input of
 * `routeDmQuestion()` (§3-6). `recordDecisionMakerRequest()` reads it after
 * the audit chain lock, so two routings of the same instance count each other.
 */
export async function readDecisionMakerThroughput(
  client: LedgerReader,
  instance: DmInstanceScope,
): Promise<{ lastHour: number; lastDay: number }> {
  if (!isDmInstanceScope(instance)) throw new DecisionMakerRequestWriteError("invalid_input");
  const rows = await client.$queryRaw<Array<{ lastHour: bigint | number; lastDay: bigint | number }>>`
    WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS "now")
    SELECT
      count(*) FILTER (WHERE r."createdAt" > db_clock."now" - INTERVAL '1 hour') AS "lastHour",
      count(*) AS "lastDay"
    FROM "AmuxDecisionMakerRequest" r CROSS JOIN db_clock
    WHERE r."route" = 'dm_proposal'
      AND r."instance" = ${instance}
      AND r."createdAt" > db_clock."now" - INTERVAL '1 day'
  `;
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker throughput read returned no row");
  return { lastHour: safeInteger(row.lastHour, "count"), lastDay: safeInteger(row.lastDay, "count") };
}

/**
 * A request's state in one statement: the request row, the database clock,
 * and what its events add up to. `probeDigest` also reports the rejection
 * already recorded for that result digest, if any. Null when no such request
 * exists; a row the core cannot read throws.
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
      e."closingKind", e."probedRejection"
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
        max(ev."kind") FILTER (WHERE ev."kind" IN ('assign_discarded', 'stale_close')) AS "closingKind",
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
};

type ExistingRequestRow = Record<string, unknown> & {
  id: string;
  route: string;
  instance: string | null;
  refusalCodes: unknown;
  createdAtEpochMs: bigint | number;
  assignmentDeadlineAtEpochMs: bigint | number;
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
 * card is routed and never stored.
 *
 * Statements: 1 lock, 1 read -- 2 for an existing request; then the switch
 * read, the throughput read (none for a provider without an instance), the
 * system writer's 3 (4 with an integrity key) and 1 insert -- 8, or 9 (7, or
 * 8, without an instance).
 */
export async function recordDecisionMakerRequest(
  tx: Prisma.TransactionClient,
  input: { binding: unknown; card: unknown },
): Promise<DecisionMakerRequestRecord> {
  const binding = parseDmRequestBinding(input.binding);
  const card = parseDmCard(input.card);
  if (!binding || !card) throw new DecisionMakerRequestWriteError("invalid_input");

  await takeAuditChainLock(tx);
  const existing = await tx.$queryRaw<ExistingRequestRow[]>`
    SELECT
      "id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
      "askingProvider", "optionSetDigest", "termListVersion", "classificationVersion", "scannerVersion",
      "route", "instance", "refusalCodes",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs",
      floor(extract(epoch FROM "assignmentDeadlineAt") * 1000)::bigint AS "assignmentDeadlineAtEpochMs"
    FROM "AmuxDecisionMakerRequest"
    WHERE "cardId" = ${binding.cardId} AND "questionRevision" = ${binding.questionRevision}
  `;
  const found = existing[0];
  if (found) {
    if (
      (found.route !== "operator" && found.route !== "dm_proposal") ||
      (found.instance !== null && !isDmInstanceScope(found.instance)) ||
      !Array.isArray(found.refusalCodes) ||
      !found.refusalCodes.every((code) => typeof code === "string")
    ) {
      throw new DecisionMakerRequestWriteError("state_unreadable");
    }
    return {
      requestId: found.id,
      created: false,
      route: found.route,
      instance: found.instance as DmInstanceScope | null,
      refusalCodes: [...(found.refusalCodes as string[])],
      sameBinding: DM_REQUEST_BINDING_KEYS.every((key) => found[key] === binding[key]),
      createdAt: isoOf(safeInteger(found.createdAtEpochMs, "clock")),
      assignmentDeadlineAt: isoOf(safeInteger(found.assignmentDeadlineAtEpochMs, "clock")),
    };
  }

  const switches = await readDecisionMakerSwitches(tx);
  const instance = dmInstanceForProvider(binding.askingProvider);
  const throughput = isDmInstanceScope(instance)
    ? await readDecisionMakerThroughput(tx, instance)
    : { lastHour: 0, lastDay: 0 };
  const decision = routeDmQuestion({
    ...dmSwitchRoutingInput(switches, instance),
    card,
    askingProvider: binding.askingProvider,
    throughput,
  });
  const record = parseDmRequestRecord(binding, decision);
  if (!record) throw new Error("AMUX Decision Maker routing produced a decision the ledger refuses");

  const requestId = randomUUID();
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
  return {
    requestId,
    created: true,
    route: record.route,
    instance: record.instance,
    refusalCodes: [...record.refusalCodes],
    sameBinding: true,
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
    assignmentDeadlineAt: isoOf(safeInteger(row.assignmentDeadlineAtEpochMs, "clock")),
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
 * process may start (§6, §8). The result deadline is given to
 * `requireLeaseAt`, and the database refuses an intent whose COMMIT reaches
 * it, as it does a late DM output.
 *
 * Statements: 1 lock, 1 state read -- 2 for an unknown request or a ledger
 * refusal; then the switch read -- 3 for a switch refusal; then the system
 * writer's 3 (4 with an integrity key) and 1 insert -- 7, or 8.
 */
export async function recordDecisionMakerTransmitIntent(
  tx: Prisma.TransactionClient,
  input: {
    requestId: unknown;
    instance: unknown;
    transmission: unknown;
    requireLeaseAt: (deadline: Date) => void;
  },
): Promise<DecisionMakerEventWrite | { recorded: false; reason: DmTransmitSwitchRefusal }> {
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
  const switchRefusal = dmTransmitSwitchRefusal(
    dmSwitchRoutingInput(await readDecisionMakerSwitches(tx), instance),
  );
  if (switchRefusal) return { recorded: false, reason: switchRefusal };
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
 * writes nothing. A DM output's result deadline is given to `requireLeaseAt`,
 * so the commit fence and, at COMMIT, the database refuse a late one.
 *
 * Statements: 1 lock, 1 state read -- 2 when nothing is written (an existing
 * pair, an unknown request, another instance); then the switch read, the
 * system writer's 3 (4 with an integrity key) and 1 insert -- 7, or 8, for a
 * result or a rejection.
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

  const { killSwitch } = await readDecisionMakerSwitches(tx);
  if (killSwitch === null) throw new DecisionMakerRequestWriteError("state_unreadable");
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
