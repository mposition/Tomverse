import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  dmCardText,
  parseDmCardText,
  validateDmOutput,
  type DmCard,
  type DmOutput,
  type DmOutputValidationFailure,
} from "@/lib/amux/decisionMakerCore";
import {
  DM_BODY_AUDIT_ACTIONS,
  DM_BODY_DELETE_AUDIT_TARGET_TYPE,
  DM_BODY_FIELDS,
  DM_OUTPUT_KINDS,
  DM_RETENTION_EVENT_AUDIT_TARGET_TYPE,
  dmBodiesRefusal,
  dmBodyAuditMetadata,
  dmBodyDigest,
  dmBodyRefusal,
  dmBodyRetentionStateFromRow,
  dmDigestKeyCheck,
  dmDigestKeyDestroyRefusal,
  dmDigestKeyPeriodStateFromRow,
  dmDigestKeyRotateRefusal,
  dmDigestKeyUsable,
  dmEraseRefusal,
  dmHoldRefusal,
  dmKeyPeriodEndMs,
  dmKeyPeriodOf,
  dmKeyPeriodStartMs,
  dmOptionSetDigest,
  dmOutputBodies,
  dmProposalForJudgmentFromRow,
  dmPurgeRefusal,
  dmRequestDigestKey,
  dmResultDetail,
  dmResultDetailShapeValid,
  dmResultDigest,
  isDmBodyField,
  isDmKeyPeriod,
  type DmBodyField,
  type DmBodyRetentionState,
  type DmDigestKeyDestroyRefusal,
  type DmDigestKeyPeriodState,
  type DmDigestKeyRotateRefusal,
  type DmEraseRefusal,
  type DmHoldRefusal,
  type DmProposalForJudgment,
  type DmPurgeRefusal,
  type DmResultDetail,
} from "@/lib/amux/decisionMakerBodyCore";
import {
  writeDecisionMakerBodyPurgeAudit,
  writeDecisionMakerDigestKeyAudit,
} from "@/lib/amux/decisionMakerBodySystemAudit";
import { decisionMakerPeriodKey, type DmDigestKeyRing } from "@/lib/amux/decisionMakerDigestKeys";
import { DM_RESULT_KINDS, isDmRequestId, parseDmCard, type DmResultKind } from "@/lib/amux/decisionMakerRequestCore";
import {
  assignDecisionMakerRequest,
  countOpenDecisionMakerRequestsCreatedBetween,
  readDecisionMakerRequestState,
  recordDecisionMakerRequest,
  submitDecisionMakerResult,
  type DecisionMakerEventRecord,
  type DecisionMakerEventWrite,
  type DecisionMakerRequestRecord,
  type DecisionMakerResultSubmission,
} from "@/lib/amux/decisionMakerRequestStore";
import { isDmInstanceScope } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * The one module that reads and writes `AmuxDecisionMakerBody`,
 * `AmuxDecisionMakerRetentionEvent`, `AmuxDecisionMakerDigestKeyEvent` and
 * `AmuxDecisionMakerResultDetail` (docs/policy/amux-decision-maker.md §10:
 * "단일 writer 모듈이 위 표들에 쓴다"), stage S1d. The result detail is the
 * ledger's structured record of a terminal result -- output kind, chosen
 * option, `irreversible` -- and is never deleted; the bodies are the only rows
 * here that ever are. Nothing else in the application names the four tables;
 * tests/amuxDecisionMakerBody.test.mjs and `npm run
 * check:protected-table-writers` fail on another writer. The one other writer
 * is the database itself: the ledger's closing events (assign_discarded,
 * stale_close, and since stage S1e a person's judgment -- confirm,
 * edit_confirm, reject) write the request's `retention_set` through a
 * trigger, so a request cannot close without its retention starting. Since
 * stage S1e it also reads a proposal for a person's judgment and stores the
 * person's edited answer, both for lib/amux/decisionMakerJudgmentStore.ts.
 *
 * It reads the request ledger only through lib/amux/decisionMakerRequestStore.ts,
 * the ledger's one reader, and composes three of that module's writes with
 * their digest keys: the routing, whose new request routed to a DM keeps its
 * card text here in the same transaction (added 2026-10-09: until then no
 * writer stored the card, so Admin could not show the question), the
 * assignment that hands the broker its request key, and the result submission
 * whose digest the app computes from the output it stores. No other module
 * calls the three ledger writes; tests/amuxDecisionMakerBody.test.mjs fails on
 * one that does.
 *
 * Every function runs on a transaction its caller owns and holds no lock
 * beyond it. Each sends a fixed list of statements -- no loop -- pinned by
 * tests/amuxDecisionMakerBody.test.mjs within §9's budget of 12 with the
 * boundary's setup and fence. A write takes the audit chain lock first (the
 * ledger writes it composes take it themselves), reads, decides with the pure
 * core (lib/amux/decisionMakerBodyCore.ts), and then writes its audit and the
 * row naming it. A refusal the core sees writes nothing.
 *
 * The rules a stored row must satisfy are the database's (migration
 * 20261008120000_amux_decision_maker_body_store); this module only builds rows
 * that pass them, so the caller gets an answer rather than an aborted
 * transaction. Permission is the caller's: a legal hold and a privacy erase
 * are a person's, with `ops:write` and a recent step-up checked before this
 * is called (§10); purge and the key registry are the system's.
 *
 * Under the kill switch every operation here stays allowed (§6's table: legal
 * hold, body deletion, stale close and expiry deletion), so none of them reads
 * the switches. The three compositions are the ledger writes they wrap, and
 * those read the switches themselves: a routing under the kill switch goes to
 * the operator and a proposal under it is recorded as a rejection, and then no
 * body is stored.
 *
 * No body reaches an audit entry, a log or an error: audit metadata is closed
 * keys and short tokens (field names, counts, ids), and the digest keys are
 * never written anywhere by it.
 */

type BodyReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export class DecisionMakerBodyWriteError extends Error {
  readonly code: "invalid_input" | "state_unreadable" | "no_operator" | "digest_key_unavailable";

  constructor(code: DecisionMakerBodyWriteError["code"]) {
    super(code);
    this.name = "DecisionMakerBodyWriteError";
    this.code = code;
  }
}

const safeInteger = (value: unknown, label: string): number => {
  const number = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`AMUX Decision Maker body store ${label} is not a safe integer`);
  return number;
};

const isoOf = (epochMs: number) => new Date(epochMs).toISOString();

const requireRequestId = (value: unknown): string => {
  if (!isDmRequestId(value)) throw new DecisionMakerBodyWriteError("invalid_input");
  return value;
};

const requireOperator = (session: Session): string => {
  const id = session?.user?.id;
  if (typeof id !== "string" || id.length === 0) throw new DecisionMakerBodyWriteError("no_operator");
  return id;
};

const sameFields = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().every((field, index) => field === [...right].sort()[index]);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One request's retention and bodies in one statement: the database clock,
 * its `retention_set` (null until it closes), its hold events counted by kind,
 * and the fields and total bytes of the bodies it has now. After a purge or an
 * erase whose outcome was lost, this is how the caller learns whether the
 * rows remain (§10: "결과를 모르면 다시 읽어 행이 남았는지로 확정한다").
 */
export async function readDecisionMakerBodyRetention(
  client: BodyReader,
  requestId: string,
): Promise<DmBodyRetentionState> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerBodyWriteError("invalid_input");
  const rows = await client.$queryRaw<unknown[]>`
    SELECT
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowEpochMs",
      (SELECT floor(extract(epoch FROM re."retentionUntil") * 1000)::bigint
         FROM "AmuxDecisionMakerRetentionEvent" re
        WHERE re."requestId" = ${requestId} AND re."kind" = 'retention_set') AS "retentionUntilEpochMs",
      (SELECT count(*) FROM "AmuxDecisionMakerRetentionEvent" re
        WHERE re."requestId" = ${requestId} AND re."kind" = 'hold_set') AS "holdSets",
      (SELECT count(*) FROM "AmuxDecisionMakerRetentionEvent" re
        WHERE re."requestId" = ${requestId} AND re."kind" = 'hold_release') AS "holdReleases",
      (SELECT coalesce(array_agg(b."field"), ARRAY[]::text[]) FROM "AmuxDecisionMakerBody" b
        WHERE b."requestId" = ${requestId}) AS "bodyFields",
      (SELECT coalesce(sum(octet_length(b."text")), 0) FROM "AmuxDecisionMakerBody" b
        WHERE b."requestId" = ${requestId}) AS "bodyBytes"
  `;
  const state = dmBodyRetentionStateFromRow(requestId, rows[0]);
  if (!state) throw new DecisionMakerBodyWriteError("state_unreadable");
  return state;
}

export type DecisionMakerBodyRecord = {
  field: DmBodyField;
  text: string;
  digest: string;
  keyPeriod: number;
  createdAt: string;
};

/**
 * A request's bodies, for the person who judges its proposal in Admin
 * (§6: the shown body's digest must equal the stored one), in one statement.
 * The text is returned to the caller only; it is never logged here.
 */
export async function readDecisionMakerBodies(
  client: BodyReader,
  requestId: string,
): Promise<DecisionMakerBodyRecord[]> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerBodyWriteError("invalid_input");
  const rows = await client.$queryRaw<
    Array<{ field: string; text: string; digest: string; keyPeriod: number; createdAtEpochMs: bigint | number }>
  >`
    SELECT "field", "text", "digest", "keyPeriod",
           floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
    FROM "AmuxDecisionMakerBody"
    WHERE "requestId" = ${requestId}
    ORDER BY "field"
  `;
  return rows.map((row) => {
    if (!isDmBodyField(row.field) || typeof row.text !== "string" || !/^[0-9a-f]{64}$/.test(row.digest)) {
      throw new DecisionMakerBodyWriteError("state_unreadable");
    }
    return {
      field: row.field,
      text: row.text,
      digest: row.digest,
      keyPeriod: safeInteger(row.keyPeriod, "key period"),
      createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
    };
  });
}

export type DecisionMakerCardTextRecord = {
  /** The card as it was routed, parsed back from the stored text. */
  card: DmCard;
  /** The stored text itself (`dmCardText()` of the card), the bytes `digest` is over. */
  text: string;
  digest: string;
  keyPeriod: number;
  createdAt: string;
};

/**
 * The card a request was routed to a DM with, as its `card_text` body keeps
 * it (§10), for the person who judges its proposal in Admin: the question, the
 * option wording and the rest of the card, beside the stored text and its
 * keyed digest, in one statement. Null when the request has no card text --
 * routed to the operator (who reads the card in AMUX), or its body purged or
 * erased. A stored text this store could not have written is
 * `state_unreadable`, never shown as a card. Reads only; the text is returned
 * to the caller and never logged here.
 */
export async function readDecisionMakerCardText(
  client: BodyReader,
  requestId: string,
): Promise<DecisionMakerCardTextRecord | null> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerBodyWriteError("invalid_input");
  const rows = await client.$queryRaw<
    Array<{ text: string; digest: string; keyPeriod: number; createdAtEpochMs: bigint | number }>
  >`
    SELECT "text", "digest", "keyPeriod",
           floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
    FROM "AmuxDecisionMakerBody"
    WHERE "requestId" = ${requestId} AND "field" = 'card_text'
  `;
  const row = rows[0];
  if (!row) return null;
  const card = parseDmCardText(row.text);
  if (rows.length !== 1 || !card || typeof row.digest !== "string" || !/^[0-9a-f]{64}$/.test(row.digest)) {
    throw new DecisionMakerBodyWriteError("state_unreadable");
  }
  return {
    card,
    text: row.text,
    digest: row.digest,
    keyPeriod: safeInteger(row.keyPeriod, "key period"),
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
  };
}

/**
 * One key period's registry state in one statement: its key check value (null
 * until rotated in), whether its destruction is recorded, the bodies it still
 * digests, and the requests of the period with an open hold.
 */
export async function readDecisionMakerDigestKeyPeriod(
  client: BodyReader,
  keyPeriod: number,
): Promise<DmDigestKeyPeriodState> {
  if (!isDmKeyPeriod(keyPeriod)) throw new DecisionMakerBodyWriteError("invalid_input");
  const rows = await client.$queryRaw<unknown[]>`
    SELECT
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowEpochMs",
      (SELECT k."keyCheck" FROM "AmuxDecisionMakerDigestKeyEvent" k
        WHERE k."keyPeriod" = ${keyPeriod} AND k."kind" = 'rotate') AS "keyCheck",
      EXISTS (SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
        WHERE k."keyPeriod" = ${keyPeriod} AND k."kind" = 'destroy') AS "destroyed",
      (SELECT count(*) FROM "AmuxDecisionMakerBody" b WHERE b."keyPeriod" = ${keyPeriod}) AS "bodies",
      (SELECT count(*) FROM (
         SELECT re."requestId" FROM "AmuxDecisionMakerRetentionEvent" re
          WHERE re."keyPeriod" = ${keyPeriod} AND re."kind" IN ('hold_set', 'hold_release')
          GROUP BY re."requestId"
         HAVING count(*) FILTER (WHERE re."kind" = 'hold_set') > count(*) FILTER (WHERE re."kind" = 'hold_release')
       ) held) AS "heldRequests"
  `;
  const state = dmDigestKeyPeriodStateFromRow(keyPeriod, rows[0]);
  if (!state) throw new DecisionMakerBodyWriteError("state_unreadable");
  return state;
}

/**
 * Requests whose bodies the expiry purge may delete now, oldest retention
 * first, at most `limit` (1 to 100) in one statement: the retention has
 * passed, no hold is open, and a body remains. For the system sweep; each
 * request is then purged in a transaction of its own.
 */
export async function listDecisionMakerPurgeCandidates(
  client: BodyReader,
  input: { limit: number },
): Promise<string[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const rows = await client.$queryRaw<Array<{ requestId: string }>>`
    SELECT re."requestId"
    FROM "AmuxDecisionMakerRetentionEvent" re
    WHERE re."kind" = 'retention_set'
      AND re."retentionUntil" <= clock_timestamp()
      AND EXISTS (SELECT 1 FROM "AmuxDecisionMakerBody" b WHERE b."requestId" = re."requestId")
      AND (SELECT count(*) FILTER (WHERE h."kind" = 'hold_set') - count(*) FILTER (WHERE h."kind" = 'hold_release')
             FROM "AmuxDecisionMakerRetentionEvent" h WHERE h."requestId" = re."requestId") <= 0
    ORDER BY re."retentionUntil", re."requestId"
    LIMIT ${input.limit}
  `;
  return rows.map((row) => requireRequestId(row.requestId));
}

// ---------------------------------------------------------------------------
// Retention: legal hold, expiry purge, privacy erase
// ---------------------------------------------------------------------------

type InsertedRow = { sequence: bigint | number | string; createdAtEpochMs: bigint | number };

export type DecisionMakerRegistryEventRecord = {
  eventId: string;
  auditLogId: string;
  /** The database's sequence, as a decimal string (it is a BIGINT). */
  sequence: string;
  createdAt: string;
};

const eventRecord = (eventId: string, auditLogId: string, rows: InsertedRow[]): DecisionMakerRegistryEventRecord => {
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker body store insert returned no row");
  return {
    eventId,
    auditLogId,
    sequence: String(row.sequence),
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
  };
};

export type DecisionMakerLegalHoldWrite =
  | { recorded: true; event: DecisionMakerRegistryEventRecord; kind: "hold_set" | "hold_release" }
  | { recorded: false; reason: "unknown_request" | DmHoldRefusal };

/**
 * A person sets or releases a legal hold on one request (§10: "hold 걸기·풀기는
 * ops:write와 최근 step-up의 사람 조작이고 사람 감사로 남는다"), in the caller's
 * transaction: the audit chain lock, the request (through the ledger's
 * reader, for its key period), its retention state, the person's
 * `amux.decision.legal_hold` audit, and the event naming it. A hold is set
 * only when none is open and released only when one is.
 *
 * Statements: 1 lock, 1 request read -- 2 for an unknown request; 1 retention
 * read -- 3 for a refusal; the administrator writer's 3 (4 with an integrity
 * key) and 1 insert -- 7, or 8.
 */
export async function recordDecisionMakerLegalHold(
  tx: Prisma.TransactionClient,
  input: { session: Session; request?: Request; requestId: unknown; action: unknown },
): Promise<DecisionMakerLegalHoldWrite> {
  const requestId = requireRequestId(input.requestId);
  if (input.action !== "set" && input.action !== "release") throw new DecisionMakerBodyWriteError("invalid_input");
  const action = input.action;
  const actorUserId = requireOperator(input.session);

  await takeAuditChainLock(tx);
  const request = await readDecisionMakerRequestState(tx, requestId);
  if (!request) return { recorded: false, reason: "unknown_request" };
  const retention = await readDecisionMakerBodyRetention(tx, requestId);
  const refusal = dmHoldRefusal(retention, action);
  if (refusal) return { recorded: false, reason: refusal };

  const kind = action === "set" ? "hold_set" : "hold_release";
  const keyPeriod = dmKeyPeriodOf(request.createdAtMs);
  const eventId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: DM_BODY_AUDIT_ACTIONS.legalHold,
    targetType: DM_RETENTION_EVENT_AUDIT_TARGET_TYPE,
    targetId: eventId,
    summary: action === "set" ? "Set a legal hold on AMUX Decision Maker bodies." : "Released a legal hold on AMUX Decision Maker bodies.",
    metadata: dmBodyAuditMetadata({ event_id: eventId, request_id: requestId, kind }),
    tx,
  });
  const inserted = await tx.$queryRaw<InsertedRow[]>`
    INSERT INTO "AmuxDecisionMakerRetentionEvent"
      ("id", "requestId", "keyPeriod", "kind", "retentionUntil", "actorKind", "actorUserId", "auditLogId")
    VALUES
      (${eventId}, ${requestId}, ${keyPeriod}, ${kind}, NULL, 'human', ${actorUserId}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return { recorded: true, event: eventRecord(eventId, auditLogId, inserted), kind };
}

export type DecisionMakerBodyDeletion =
  | { deleted: true; fields: DmBodyField[]; auditLogId: string }
  | { deleted: false; reason: DmPurgeRefusal | DmEraseRefusal };

/**
 * The fields a delete or an insert returned, which must be the ones it was
 * built for: the read and the write are under the same audit chain lock,
 * which every body write takes first, so a difference means a writer outside
 * this module.
 */
const returnedFields = (rows: Array<{ field: string }>, expected: readonly DmBodyField[]): DmBodyField[] => {
  const fields = rows.map((row) => row.field);
  if (!fields.every(isDmBodyField) || !sameFields(fields, expected)) {
    throw new Error("AMUX Decision Maker bodies changed under the audit chain lock");
  }
  return DM_BODY_FIELDS.filter((field) => fields.includes(field));
};

/**
 * The system deletes a closed request's bodies once its retention has passed
 * (§10: "기한 삭제는 시스템 정리 작업이 요청 단위 잠금 아래 삭제와
 * .body_purge 감사를 한 트랜잭션으로 하며"): the audit chain lock, the
 * retention state, the router's `amux.decision.body_purge` audit naming the
 * request and its fields, and the delete, which the trigger allows only under
 * that audit, after `retentionUntil` and with no hold open. An outcome that
 * was lost is settled by `readDecisionMakerBodyRetention()`, never by
 * purging again blind.
 *
 * Statements: 1 lock, 1 read -- 2 for a refusal; the system writer's 3 (4
 * with an integrity key) and 1 delete -- 6, or 7.
 */
export async function purgeDecisionMakerBodies(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown },
): Promise<DecisionMakerBodyDeletion> {
  const requestId = requireRequestId(input.requestId);
  await takeAuditChainLock(tx);
  const state = await readDecisionMakerBodyRetention(tx, requestId);
  const refusal = dmPurgeRefusal(state);
  if (refusal) return { deleted: false, reason: refusal };
  const auditLogId = await writeDecisionMakerBodyPurgeAudit(tx, {
    requestId,
    metadata: dmBodyAuditMetadata({
      request_id: requestId,
      fields: state.bodyFields,
      body_count: String(state.bodyFields.length),
    }),
  });
  const rows = await tx.$queryRaw<Array<{ field: string }>>`
    DELETE FROM "AmuxDecisionMakerBody"
    WHERE "requestId" = ${requestId}
    RETURNING "field"
  `;
  return { deleted: true, fields: returnedFields(rows, state.bodyFields), auditLogId };
}

/**
 * §10's one exception: once a personal-data deletion request is confirmed, a
 * person deletes the named bodies of one request, before or after its
 * retention, under the person's `amux.decision.body_erase` audit. An open hold
 * has to be released first. Fields the request no longer has are left out of
 * the audit; asking for none it has is a refusal.
 *
 * Statements: 1 lock, 1 read -- 2 for a refusal; the administrator writer's 3
 * (4 with an integrity key) and 1 delete -- 6, or 7.
 */
export async function eraseDecisionMakerBodies(
  tx: Prisma.TransactionClient,
  input: { session: Session; request?: Request; requestId: unknown; fields: unknown },
): Promise<DecisionMakerBodyDeletion> {
  const requestId = requireRequestId(input.requestId);
  if (
    !Array.isArray(input.fields) ||
    input.fields.length === 0 ||
    !input.fields.every(isDmBodyField) ||
    new Set(input.fields).size !== input.fields.length
  ) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const requested = input.fields as DmBodyField[];
  requireOperator(input.session);

  await takeAuditChainLock(tx);
  const state = await readDecisionMakerBodyRetention(tx, requestId);
  const refusal = dmEraseRefusal(state, requested);
  if (refusal) return { deleted: false, reason: refusal };
  const present = state.bodyFields.filter((field) => requested.includes(field));
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: DM_BODY_AUDIT_ACTIONS.bodyErase,
    targetType: DM_BODY_DELETE_AUDIT_TARGET_TYPE,
    targetId: requestId,
    summary: "Erased AMUX Decision Maker bodies on a confirmed personal-data deletion request.",
    metadata: dmBodyAuditMetadata({ request_id: requestId, fields: present, body_count: String(present.length) }),
    tx,
  });
  const rows = await tx.$queryRaw<Array<{ field: string }>>`
    DELETE FROM "AmuxDecisionMakerBody"
    WHERE "requestId" = ${requestId} AND "field" = ANY(${present}::text[])
    RETURNING "field"
  `;
  return { deleted: true, fields: returnedFields(rows, present), auditLogId };
}

// ---------------------------------------------------------------------------
// The key registry
// ---------------------------------------------------------------------------

export type DecisionMakerDigestKeyWrite<R> =
  | { recorded: true; event: DecisionMakerRegistryEventRecord }
  | { recorded: false; reason: R };

/**
 * The system puts one key period's key into use (§10: "키는 30일 단위로
 * 바꾸고"; "키 교체·파기는 시스템 감사로 남긴다"): the key must already be in
 * the server's key ring, and only its check value is recorded. Once per
 * period, never after the period's destruction, and no further ahead than the
 * next period.
 *
 * Statements: none for a key the ring does not hold; 1 lock, 1 read -- 2 for a
 * refusal; the system writer's 3 (4 with an integrity key) and 1 insert -- 6,
 * or 7.
 */
export async function rotateDecisionMakerDigestKey(
  tx: Prisma.TransactionClient,
  input: { keyPeriod: unknown; keyRing: DmDigestKeyRing },
): Promise<DecisionMakerDigestKeyWrite<DmDigestKeyRotateRefusal | "key_not_in_ring">> {
  if (!isDmKeyPeriod(input.keyPeriod) || !(input.keyRing instanceof Map)) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const keyPeriod = input.keyPeriod;
  const periodKey = decisionMakerPeriodKey(input.keyRing, keyPeriod);
  if (!periodKey) return { recorded: false, reason: "key_not_in_ring" };

  await takeAuditChainLock(tx);
  const state = await readDecisionMakerDigestKeyPeriod(tx, keyPeriod);
  const refusal = dmDigestKeyRotateRefusal(state);
  if (refusal) return { recorded: false, reason: refusal };
  const eventId = randomUUID();
  const auditLogId = await writeDecisionMakerDigestKeyAudit(tx, {
    kind: "rotate",
    eventId,
    metadata: dmBodyAuditMetadata({ event_id: eventId, kind: "rotate", key_period: String(keyPeriod) }),
  });
  const inserted = await tx.$queryRaw<InsertedRow[]>`
    INSERT INTO "AmuxDecisionMakerDigestKeyEvent" ("id", "keyPeriod", "kind", "keyCheck", "auditLogId")
    VALUES (${eventId}, ${keyPeriod}, 'rotate', ${dmDigestKeyCheck(periodKey)}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return { recorded: true, event: eventRecord(eventId, auditLogId, inserted) };
}

/**
 * The system records that one key period's key is destroyed (§10: "한 기간의
 * 본문 행이 모두 지워지면 그 기간의 키를 파기해, 원장의 digest를 더는 본문과
 * 대조할 수 없게 한다"). Refused while the period has not ended, while a body
 * of the period remains, while a hold is open on one of its requests, and
 * while one of its requests routed to a DM is still open. The record is the
 * instruction: the operator then removes the period's entry from
 * `AMUX_DM_DIGEST_KEYS`. From the record on, no body of the period can be
 * stored, whatever the key ring still holds.
 *
 * Statements: 1 lock, 1 open-request count (through the ledger's reader), 1
 * read -- 3 for a refusal; the system writer's 3 (4 with an integrity key) and
 * 1 insert -- 7, or 8.
 */
export async function destroyDecisionMakerDigestKey(
  tx: Prisma.TransactionClient,
  input: { keyPeriod: unknown },
): Promise<DecisionMakerDigestKeyWrite<DmDigestKeyDestroyRefusal>> {
  if (!isDmKeyPeriod(input.keyPeriod)) throw new DecisionMakerBodyWriteError("invalid_input");
  const keyPeriod = input.keyPeriod;

  await takeAuditChainLock(tx);
  const openRequests = await countOpenDecisionMakerRequestsCreatedBetween(tx, {
    fromMs: dmKeyPeriodStartMs(keyPeriod),
    toMs: dmKeyPeriodEndMs(keyPeriod),
  });
  const state = await readDecisionMakerDigestKeyPeriod(tx, keyPeriod);
  const refusal = dmDigestKeyDestroyRefusal(state, openRequests);
  if (refusal) return { recorded: false, reason: refusal };
  const eventId = randomUUID();
  const auditLogId = await writeDecisionMakerDigestKeyAudit(tx, {
    kind: "destroy",
    eventId,
    metadata: dmBodyAuditMetadata({ event_id: eventId, kind: "destroy", key_period: String(keyPeriod) }),
  });
  const inserted = await tx.$queryRaw<InsertedRow[]>`
    INSERT INTO "AmuxDecisionMakerDigestKeyEvent" ("id", "keyPeriod", "kind", "keyCheck", "auditLogId")
    VALUES (${eventId}, ${keyPeriod}, 'destroy', NULL, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return { recorded: true, event: eventRecord(eventId, auditLogId, inserted) };
}

// ---------------------------------------------------------------------------
// The three ledger writes that carry digest keys
// ---------------------------------------------------------------------------

export type DecisionMakerRoutedRequest = DecisionMakerRequestRecord & {
  /**
   * The card text this call stored: only with a new request routed to a DM.
   * Null for a request routed to the operator -- who reads the card in AMUX,
   * and whose request is closed from its creation, so the body guard refuses
   * it a body -- and for an existing request, whose first routing stands
   * (§9).
   */
  cardText: { digest: string; keyPeriod: number; bytes: number } | null;
};

/**
 * §2-2, §3, §10: routes one typed ask through the ledger's routing,
 * `recordDecisionMakerRequest()`, and when that records a new request routed
 * to a DM, stores the request's card text in the same transaction -- the
 * question, the option wording and the rest of the card as
 * `dmCardText()` serializes them (lib/amux/decisionMakerCore.ts), which is
 * what Admin shows the operator beside a proposal -- bound to the router's
 * `amux.decision.route` audit the routing has just written, as the body guard
 * requires (migration 20261008120000_amux_decision_maker_body_store: the card
 * text with the request row's own route audit of the same transaction, so it
 * can never be added later). The application routes only through here.
 *
 * The text passes `dmBodyRefusal()`, the secret scan included (§10: "저장 전에
 * secret 검사를 통과해야 한다"), before it is sent. The router never sends a
 * card it would refuse: `routeDmQuestion()` measures §5's 16 KiB on the same
 * text and scans it with the same scanner, so a card over the cap or with a
 * secret goes to the operator (`input_limit_exceeded`,
 * `card_secret_detected`) and stores nothing here. A refusal at this point
 * would mean the two drifted apart; it throws, and the caller's transaction
 * rolls back.
 *
 * The routing and the stored text read one private copy of the card, so the
 * text is the card the routing decided on.
 *
 * The text is keyed under the request's key K_R and stored only while the
 * registry holds the period's key undestroyed. If it does not, nothing is
 * stored and this throws `digest_key_unavailable`, so the caller's
 * transaction -- which already holds the routing's audit and request rows --
 * rolls back and the question stays with the operator, as a route failure
 * does (§2-1). Such a request could not have been assigned either: the keyed
 * assignment refuses an unregistered key.
 *
 * Statements: the routing's own -- 2 for an existing request, 7 (8 with an
 * integrity key) for a provider without an instance, 8 (9) otherwise -- and 1
 * card text insert for a new request routed to a DM: 9, or 10. With the
 * boundary's setup and fence, 12 at most (§9).
 */
export async function recordDecisionMakerRequestWithCardText(
  tx: Prisma.TransactionClient,
  input: { binding: unknown; card: unknown; keyRing: DmDigestKeyRing },
): Promise<DecisionMakerRoutedRequest> {
  const parsed = parseDmCard(input.card);
  // An unreadable card goes to the routing as it came, which refuses it before any statement.
  const card: unknown = parsed === null ? input.card : structuredClone(parsed);
  const record = await recordDecisionMakerRequest(tx, { binding: input.binding, card, keyRing: input.keyRing });
  if (!record.created || record.route !== "dm_proposal") return { ...record, cardText: null };
  if (parsed === null || record.routeAuditLogId === null) {
    throw new Error("AMUX Decision Maker routing recorded a request without its card or route audit");
  }

  const text = dmCardText(card as DmCard);
  const refusal = dmBodyRefusal("card_text", text);
  if (refusal) throw new Error(`AMUX Decision Maker routed a card the body store refuses: ${refusal}`);
  const keyPeriod = dmKeyPeriodOf(Date.parse(record.createdAt));
  const periodKey = decisionMakerPeriodKey(input.keyRing, keyPeriod);
  if (!periodKey) throw new DecisionMakerBodyWriteError("digest_key_unavailable");
  const keyCheck = dmDigestKeyCheck(periodKey);
  const digest = dmBodyDigest(dmRequestDigestKey(periodKey, record.requestId), "card_text", text);
  const rows = await tx.$queryRaw<Array<{ digest: string }>>`
    INSERT INTO "AmuxDecisionMakerBody"
      ("id", "requestId", "field", "text", "keyPeriod", "keyCheck", "digest", "auditLogId")
    SELECT ${randomUUID()}, ${record.requestId}, 'card_text', ${text}, ${keyPeriod}::integer, ${keyCheck},
           ${digest}, ${record.routeAuditLogId}
    WHERE EXISTS (
        SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
        WHERE k."keyPeriod" = ${keyPeriod}::integer AND k."kind" = 'rotate' AND k."keyCheck" = ${keyCheck}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
        WHERE k."keyPeriod" = ${keyPeriod}::integer AND k."kind" = 'destroy'
      )
    RETURNING "digest"
  `;
  if (rows.length !== 1 || rows[0]!.digest !== digest) throw new DecisionMakerBodyWriteError("digest_key_unavailable");
  return { ...record, cardText: { digest, keyPeriod, bytes: Buffer.byteLength(text, "utf8") } };
}

export type DecisionMakerKeyedAssignment =
  | { recorded: true; event: DecisionMakerEventRecord; keyPeriod: number; requestKey: Buffer }
  | Extract<DecisionMakerEventWrite, { recorded: false }>
  | { recorded: false; reason: "digest_key_unavailable" };

/**
 * §2-1 and §2-4: the router's assignment, with the request key K_R the broker
 * keys its input payload and snapshot manifest digests with (§10's
 * transmission intent records them). The request's key period must be in the
 * key ring and registered with the same key, not destroyed; otherwise nothing
 * is assigned and the question stays with the operator.
 *
 * K_R is a secret of this one request. The caller sends it only to the
 * assigned broker, never logs or stores it; the broker keeps it with the
 * request directory and deletes it with that directory (§5). It opens no
 * other request and does not give back the period key.
 *
 * Statements: 1 request read -- 1 for an unknown request or a key the ring
 * does not hold; 1 registry read -- 2 for an unusable key; then the ledger's
 * assignment: 2 for its refusal, or 6 (7 with an integrity key) -- 8, or 9.
 */
export async function assignDecisionMakerRequestWithDigestKey(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown; requireLeaseAt: (deadline: Date) => void; keyRing: DmDigestKeyRing },
): Promise<DecisionMakerKeyedAssignment> {
  const requestId = requireRequestId(input.requestId);
  if (typeof input.requireLeaseAt !== "function" || !(input.keyRing instanceof Map)) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const state = await readDecisionMakerRequestState(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const keyPeriod = dmKeyPeriodOf(state.createdAtMs);
  const periodKey = decisionMakerPeriodKey(input.keyRing, keyPeriod);
  if (!periodKey) return { recorded: false, reason: "digest_key_unavailable" };
  const registry = await readDecisionMakerDigestKeyPeriod(tx, keyPeriod);
  if (!dmDigestKeyUsable(registry, dmDigestKeyCheck(periodKey))) {
    return { recorded: false, reason: "digest_key_unavailable" };
  }
  const write = await assignDecisionMakerRequest(tx, { requestId, requireLeaseAt: input.requireLeaseAt });
  if (!write.recorded) return write;
  return { recorded: true, event: write.event, keyPeriod, requestKey: dmRequestDigestKey(periodKey, requestId) };
}


/**
 * What the broker submits: the DM's output as the exact bytes it produced,
 * with the card's options as the DM received them, or no output.
 */
export type DecisionMakerOutput =
  | { kind: "output"; raw: string; options: ReadonlyArray<{ id: string; label: string }> }
  | { kind: "timeout" }
  | { kind: "unavailable" };

const ownKeysAre = (value: object, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const parseOutput = (value: unknown): DecisionMakerOutput | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "timeout" || record.kind === "unavailable") {
    return ownKeysAre(record, ["kind"]) ? { kind: record.kind } : null;
  }
  if (
    record.kind === "output" &&
    ownKeysAre(record, ["kind", "raw", "options"]) &&
    typeof record.raw === "string" &&
    Array.isArray(record.options) &&
    record.options.every(
      (option) =>
        option !== null &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        ownKeysAre(option, ["id", "label"]) &&
        typeof (option as { id: unknown }).id === "string" &&
        typeof (option as { label: unknown }).label === "string",
    )
  ) {
    const options = (record.options as Array<{ id: string; label: string }>).map(({ id, label }) => ({ id, label }));
    return { kind: "output", raw: record.raw, options };
  }
  return null;
};

export type DecisionMakerOutputSubmission =
  | { status: "unknown_request" }
  | { status: "digest_key_unavailable" }
  | { status: "option_set_mismatch" }
  | {
      status: "submitted";
      resultKind: DmResultKind;
      /** Why a DM output was not a proposal or an escalation; null otherwise. */
      validationFailure: DmOutputValidationFailure | null;
      resultDigest: string;
      result: DecisionMakerResultSubmission;
      /** The structured detail recorded with an accepted result in this call; null otherwise. */
      detail: DmResultDetail | null;
      /** The bodies this call stored: none unless the result was accepted now. */
      storedFields: DmBodyField[];
    };

/**
 * §6, §9, §10: a DM's output, validated here, digested by the app and
 * recorded as the request's terminal result, with its structured detail and
 * its bodies in the same transaction when the ledger accepts it.
 *
 * The options the output is checked against are the request's own: the
 * submitted list must digest, under the request key, to the option set
 * digest the store computed at routing, or nothing is recorded
 * (`option_set_mismatch`). A fake id added to the output and the list, or a
 * real one dropped to force a validation failure, is refused before the
 * ledger is touched. A digest that does not match can also mean that the key
 * ring holds another key for the period than the one the option set was
 * digested with, so on a mismatch -- and only then -- the registry is read:
 * when it does not hold the ring's key undestroyed, the answer is
 * `digest_key_unavailable`, never a wrong option set. (A matching digest
 * needs no read here: the detail statement below refuses an unregistered key
 * for every result.)
 *
 * The result digest is computed here, under the request key, from the exact
 * output bytes submitted (or the fixed no-output marker of a timeout or an
 * unavailable DM) -- never taken from the caller -- so a resubmission of the
 * same output is the same (request, digest) pair the ledger answers
 * idempotently, and the broker, which holds K_R, can compute the pair to look
 * up a lost response. The output is checked with `validateDmOutput()`; a
 * proposal stores its rationale (and a free-text answer), an escalation its
 * reason, and a validation failure nothing. A text the validator passes but
 * the body store cannot hold (a lone surrogate or a NUL) is recorded as a
 * schema validation failure.
 *
 * With every result the ledger accepts in this call, of every kind, one
 * statement writes `AmuxDecisionMakerResultDetail` -- the output's kind, the
 * option a select chose and the `irreversible` flag Admin shows first (§6),
 * no free text -- and the bodies, only if the registry holds the key check
 * of the key this call digested with and has not destroyed its period. If it
 * does not, nothing is written and this throws `digest_key_unavailable`, so
 * the caller's transaction rolls the result back: no result commits under a
 * key the registry does not hold. The detail's and the body's triggers hold
 * the same rule. An existing pair already has its detail, and a rejection --
 * a proposal under the kill switch included -- has none and stores no body.
 *
 * Statements: 1 request read -- 1 for an unknown request or a key the ring
 * does not hold; 1 registry read after an option set that does not match -- 2
 * for `option_set_mismatch` or the key it reveals as unusable; otherwise the
 * ledger's submission: 2 when it writes nothing, 3 when its switch read finds
 * the store unreadable, 7 (8 with an integrity key) for a result or a
 * rejection; and 1 detail-and-body insert for an accepted result -- 9, or 10.
 */
export async function submitDecisionMakerOutput(
  tx: Prisma.TransactionClient,
  input: {
    requestId: unknown;
    instance: unknown;
    binding: unknown;
    output: unknown;
    requireLeaseAt: (deadline: Date) => void;
    keyRing: DmDigestKeyRing;
  },
): Promise<DecisionMakerOutputSubmission> {
  const requestId = requireRequestId(input.requestId);
  const output = parseOutput(input.output);
  if (!isDmInstanceScope(input.instance) || !output || !(input.keyRing instanceof Map)) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const state = await readDecisionMakerRequestState(tx, requestId);
  if (!state) return { status: "unknown_request" };
  const keyPeriod = dmKeyPeriodOf(state.createdAtMs);
  const periodKey = decisionMakerPeriodKey(input.keyRing, keyPeriod);
  if (!periodKey) return { status: "digest_key_unavailable" };
  const requestKey = dmRequestDigestKey(periodKey, requestId);

  let resultKind: DmResultKind;
  let validationFailure: DmOutputValidationFailure | null = null;
  let validOutput: DmOutput | null = null;
  let bodies: Array<{ field: DmBodyField; text: string }> = [];
  if (output.kind === "output") {
    // Only the options the request was routed with -- unless the ring's key is
    // not the registered one, which makes every option set look wrong.
    if (dmOptionSetDigest(requestKey, output.options) !== state.binding.optionSetDigest) {
      const registry = await readDecisionMakerDigestKeyPeriod(tx, keyPeriod);
      return dmDigestKeyUsable(registry, dmDigestKeyCheck(periodKey))
        ? { status: "option_set_mismatch" }
        : { status: "digest_key_unavailable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.raw);
    } catch {
      parsed = undefined;
    }
    const verdict = validateDmOutput(
      parsed,
      output.options.map((option) => option.id),
    );
    if (verdict.outcome === "validation_failure") {
      resultKind = "validation_failure";
      validationFailure = verdict.failure;
    } else {
      resultKind = verdict.outcome === "proposal" ? "proposal" : "escalate";
      validOutput = verdict.output;
      bodies = dmOutputBodies(verdict.output);
      if (dmBodiesRefusal(bodies) !== null) {
        resultKind = "validation_failure";
        validationFailure = "schema";
        validOutput = null;
        bodies = [];
      }
    }
  } else {
    resultKind = output.kind;
  }
  const resultDigest = dmResultDigest(requestKey, output.kind === "output" ? { kind: "output", raw: output.raw } : { kind: output.kind });

  const result = await submitDecisionMakerResult(tx, {
    requestId,
    submission: { instance: input.instance, resultKind, resultDigest, binding: input.binding },
    requireLeaseAt: input.requireLeaseAt,
  });
  if (result.status !== "accepted") {
    return { status: "submitted", resultKind, validationFailure, resultDigest, result, detail: null, storedFields: [] };
  }

  const detail = dmResultDetail(validOutput);
  if (!dmResultDetailShapeValid(resultKind, detail)) {
    throw new Error("AMUX Decision Maker result detail does not fit its result kind");
  }
  const keyCheck = dmDigestKeyCheck(periodKey);
  // One statement: the detail, naming the result and its audit row, only
  // while the registry holds this key undestroyed; and the bodies only with
  // the detail. The triggers re-check both under the key period's lock.
  const written = await tx.$queryRaw<Array<{ details: bigint | number; fields: string[] }>>`
    WITH "detail" AS (
      INSERT INTO "AmuxDecisionMakerResultDetail"
        ("id", "requestId", "resultEventId", "resultKind", "outputKind", "optionId", "irreversible",
         "keyPeriod", "keyCheck", "auditLogId")
      SELECT ${randomUUID()}, ${requestId}, ${result.event.eventId}, ${resultKind}, ${detail.outputKind}::text,
             ${detail.optionId}::text, ${detail.irreversible}::boolean, ${keyPeriod}::integer, ${keyCheck},
             ${result.event.auditLogId}
      WHERE EXISTS (
          SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
          WHERE k."keyPeriod" = ${keyPeriod}::integer AND k."kind" = 'rotate' AND k."keyCheck" = ${keyCheck}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
          WHERE k."keyPeriod" = ${keyPeriod}::integer AND k."kind" = 'destroy'
        )
      RETURNING "id"
    ), "bodies" AS (
      INSERT INTO "AmuxDecisionMakerBody"
        ("id", "requestId", "field", "text", "keyPeriod", "keyCheck", "digest", "auditLogId")
      SELECT b."id", ${requestId}, b."field", b."text", ${keyPeriod}::integer, ${keyCheck}, b."digest",
             ${result.event.auditLogId}
      FROM unnest(
        ${bodies.map(() => randomUUID())}::text[],
        ${bodies.map((body) => body.field)}::text[],
        ${bodies.map((body) => body.text)}::text[],
        ${bodies.map((body) => dmBodyDigest(requestKey, body.field, body.text))}::text[]
      ) AS b("id", "field", "text", "digest")
      WHERE EXISTS (SELECT 1 FROM "detail")
      RETURNING "field"
    )
    SELECT
      (SELECT count(*) FROM "detail") AS "details",
      coalesce((SELECT array_agg("field") FROM "bodies"), ARRAY[]::text[]) AS "fields"
  `;
  const row = written[0];
  if (!row) throw new Error("AMUX Decision Maker result detail insert returned no row");
  if (Number(row.details) !== 1) throw new DecisionMakerBodyWriteError("digest_key_unavailable");
  return {
    status: "submitted",
    resultKind,
    validationFailure,
    resultDigest,
    result,
    detail,
    storedFields: returnedFields(
      (row.fields ?? []).map((field) => ({ field })),
      bodies.map((body) => body.field),
    ),
  };
}

export type DecisionMakerResultDetailRecord = DmResultDetail & {
  resultKind: DmResultKind;
  keyPeriod: number;
  createdAt: string;
};

/**
 * The structured detail of a request's terminal result, in one statement:
 * what Admin shows beside the bodies before the operator judges a proposal --
 * its kind, the option a select chose, and `irreversible` (§6: shown first
 * when true). Null when no detail was recorded.
 */
export async function readDecisionMakerResultDetail(
  client: BodyReader,
  requestId: string,
): Promise<DecisionMakerResultDetailRecord | null> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerBodyWriteError("invalid_input");
  const rows = await client.$queryRaw<
    Array<{
      resultKind: string;
      outputKind: string | null;
      optionId: string | null;
      irreversible: boolean | null;
      keyPeriod: number;
      createdAtEpochMs: bigint | number;
    }>
  >`
    SELECT "resultKind", "outputKind", "optionId", "irreversible", "keyPeriod",
           floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
    FROM "AmuxDecisionMakerResultDetail"
    WHERE "requestId" = ${requestId}
  `;
  const row = rows[0];
  if (!row) return null;
  const detail: DmResultDetail = {
    outputKind: (row.outputKind ?? null) as DmResultDetail["outputKind"],
    optionId: row.optionId ?? null,
    irreversible: row.irreversible ?? null,
  };
  if (
    !(DM_RESULT_KINDS as readonly string[]).includes(row.resultKind) ||
    !(row.outputKind === null || (DM_OUTPUT_KINDS as readonly string[]).includes(row.outputKind)) ||
    !dmResultDetailShapeValid(row.resultKind, detail)
  ) {
    throw new DecisionMakerBodyWriteError("state_unreadable");
  }
  return {
    ...detail,
    resultKind: row.resultKind as DmResultKind,
    keyPeriod: safeInteger(row.keyPeriod, "key period"),
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
  };
}

// ---------------------------------------------------------------------------
// A person's judgment (stage S1e)
// ---------------------------------------------------------------------------

/**
 * A request's proposal as the judgment store reads it (§6: a confirmation
 * stands only while "Admin이 보여 준 제안 본문과 스냅샷 정보의 digest가 저장된
 * 값과 같을 때"), in one statement: its terminal result's detail, the keyed
 * digests of its DM answer, rationale and operator answer bodies, the bytes
 * all its bodies hold, and the registry entry of `keyPeriod` -- the request's
 * own, which the caller derives from the request's database-clock creation.
 * Never a body's text. Reads only.
 */
export async function readDecisionMakerProposalForJudgment(
  client: BodyReader,
  input: { requestId: string; keyPeriod: number },
): Promise<DmProposalForJudgment> {
  if (!isDmRequestId(input.requestId) || !isDmKeyPeriod(input.keyPeriod)) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const rows = await client.$queryRaw<unknown[]>`
    SELECT
      d."resultEventId", d."resultKind", d."outputKind", d."optionId", d."irreversible",
      b."answerDigest", b."rationaleDigest", b."operatorAnswerDigest", b."bodyBytes",
      k."keyCheck", k."keyDestroyed"
    FROM (SELECT 1) AS "probe"
    LEFT JOIN "AmuxDecisionMakerResultDetail" d ON d."requestId" = ${input.requestId}
    CROSS JOIN LATERAL (
      SELECT
        max(x."digest") FILTER (WHERE x."field" = 'dm_answer') AS "answerDigest",
        max(x."digest") FILTER (WHERE x."field" = 'dm_rationale') AS "rationaleDigest",
        max(x."digest") FILTER (WHERE x."field" = 'operator_answer') AS "operatorAnswerDigest",
        coalesce(sum(octet_length(x."text")), 0) AS "bodyBytes"
      FROM "AmuxDecisionMakerBody" x
      WHERE x."requestId" = ${input.requestId}
    ) b
    CROSS JOIN LATERAL (
      SELECT
        max(e."keyCheck") FILTER (WHERE e."kind" = 'rotate') AS "keyCheck",
        coalesce(bool_or(e."kind" = 'destroy'), false) AS "keyDestroyed"
      FROM "AmuxDecisionMakerDigestKeyEvent" e
      WHERE e."keyPeriod" = ${input.keyPeriod}::integer
    ) k
  `;
  const proposal = dmProposalForJudgmentFromRow(rows[0]);
  if (!proposal) throw new DecisionMakerBodyWriteError("state_unreadable");
  return proposal;
}

/**
 * §6: "운영자가 고친 답은 새 본문 행이 되고 그 digest가 판정에 기록된다". A
 * person's edited answer is stored under the `amux.decision.edit_confirm`
 * audit the judgment store has written in this transaction, keyed under the
 * request's key like every other body, and only while the registry holds that
 * key undestroyed. One statement. The caller checked the text with
 * `dmBodyRefusal()` (the secret scan included) before writing anything; a text
 * that fails it here is a programming error. Without the period's key in the
 * ring, or under a key the registry does not hold, nothing is stored and this
 * throws `digest_key_unavailable`, so the caller's transaction -- which already
 * holds the audit row -- rolls back.
 *
 * The trigger allows the row only for an open request routed to a DM, under a
 * person's edit_confirm of this transaction that targets the request and names
 * it in its metadata; the judgment written next in the same transaction closes
 * the request, after which no operator answer can be added.
 */
export async function storeDecisionMakerOperatorAnswer(
  tx: Prisma.TransactionClient,
  input: { requestId: string; requestCreatedAtMs: number; text: string; auditLogId: string; keyRing: DmDigestKeyRing },
): Promise<{ digest: string; keyPeriod: number }> {
  if (
    !isDmRequestId(input.requestId) ||
    !Number.isSafeInteger(input.requestCreatedAtMs) ||
    input.requestCreatedAtMs < 0 ||
    typeof input.auditLogId !== "string" ||
    input.auditLogId.length === 0 ||
    !(input.keyRing instanceof Map) ||
    dmBodyRefusal("operator_answer", input.text) !== null
  ) {
    throw new DecisionMakerBodyWriteError("invalid_input");
  }
  const keyPeriod = dmKeyPeriodOf(input.requestCreatedAtMs);
  const periodKey = decisionMakerPeriodKey(input.keyRing, keyPeriod);
  if (!periodKey) throw new DecisionMakerBodyWriteError("digest_key_unavailable");
  const keyCheck = dmDigestKeyCheck(periodKey);
  const digest = dmBodyDigest(dmRequestDigestKey(periodKey, input.requestId), "operator_answer", input.text);
  const rows = await tx.$queryRaw<Array<{ digest: string }>>`
    INSERT INTO "AmuxDecisionMakerBody"
      ("id", "requestId", "field", "text", "keyPeriod", "keyCheck", "digest", "auditLogId")
    SELECT ${randomUUID()}, ${input.requestId}, 'operator_answer', ${input.text}, ${keyPeriod}::integer, ${keyCheck},
           ${digest}, ${input.auditLogId}
    WHERE EXISTS (
        SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
        WHERE k."keyPeriod" = ${keyPeriod}::integer AND k."kind" = 'rotate' AND k."keyCheck" = ${keyCheck}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "AmuxDecisionMakerDigestKeyEvent" k
        WHERE k."keyPeriod" = ${keyPeriod}::integer AND k."kind" = 'destroy'
      )
    RETURNING "digest"
  `;
  if (rows.length !== 1 || rows[0]!.digest !== digest) throw new DecisionMakerBodyWriteError("digest_key_unavailable");
  return { digest, keyPeriod };
}
