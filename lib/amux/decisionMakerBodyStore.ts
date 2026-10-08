import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { validateDmOutput, type DmOutputValidationFailure } from "@/lib/amux/decisionMakerCore";
import {
  DM_BODY_AUDIT_ACTIONS,
  DM_BODY_DELETE_AUDIT_TARGET_TYPE,
  DM_BODY_FIELDS,
  DM_RETENTION_EVENT_AUDIT_TARGET_TYPE,
  dmBodiesRefusal,
  dmBodyAuditMetadata,
  dmBodyDigest,
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
  dmOutputBodies,
  dmPurgeRefusal,
  dmRequestDigestKey,
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
  type DmPurgeRefusal,
} from "@/lib/amux/decisionMakerBodyCore";
import {
  writeDecisionMakerBodyPurgeAudit,
  writeDecisionMakerDigestKeyAudit,
} from "@/lib/amux/decisionMakerBodySystemAudit";
import { decisionMakerPeriodKey, type DmDigestKeyRing } from "@/lib/amux/decisionMakerDigestKeys";
import { isDmRequestId, type DmResultKind } from "@/lib/amux/decisionMakerRequestCore";
import {
  assignDecisionMakerRequest,
  countOpenDecisionMakerRequestsCreatedBetween,
  readDecisionMakerRequestState,
  submitDecisionMakerResult,
  type DecisionMakerEventRecord,
  type DecisionMakerEventWrite,
  type DecisionMakerResultSubmission,
} from "@/lib/amux/decisionMakerRequestStore";
import { isDmInstanceScope } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * The one module that reads and writes `AmuxDecisionMakerBody`,
 * `AmuxDecisionMakerRetentionEvent` and `AmuxDecisionMakerDigestKeyEvent`
 * (docs/policy/amux-decision-maker.md §10: "단일 writer 모듈이 위 표들에
 * 쓴다"), stage S1d. Nothing else in the application names the three tables;
 * tests/amuxDecisionMakerBody.test.mjs and `npm run
 * check:protected-table-writers` fail on another writer. The one other writer
 * is the database itself: the ledger's closing events (assign_discarded,
 * stale_close) write the request's `retention_set` through a trigger, so a
 * request cannot close without its retention starting.
 *
 * It reads the request ledger only through lib/amux/decisionMakerRequestStore.ts,
 * the ledger's one reader, and composes two of that module's writes with
 * their digest keys: the assignment that hands the broker its request key,
 * and the result submission whose digest the app computes from the output it
 * stores.
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
 * the switches. The two compositions are the ledger writes they wrap, and
 * those read the switches themselves: a proposal under the kill switch is
 * recorded as a rejection, and then no body is stored.
 *
 * No body reaches an audit entry, a log or an error: audit metadata is closed
 * keys and short tokens (field names, counts, ids), and the digest keys are
 * never written anywhere by it.
 */

type BodyReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export class DecisionMakerBodyWriteError extends Error {
  readonly code: "invalid_input" | "state_unreadable" | "no_operator";

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
// The two ledger writes that carry digest keys
// ---------------------------------------------------------------------------

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

/** What the broker submits: the DM's output as the exact bytes it produced, or no output. */
export type DecisionMakerOutput =
  | { kind: "output"; raw: string; optionIds: readonly string[] }
  | { kind: "timeout" }
  | { kind: "unavailable" };

const parseOutput = (value: unknown): DecisionMakerOutput | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "timeout" || record.kind === "unavailable") {
    return Object.keys(record).length === 1 ? { kind: record.kind } : null;
  }
  if (
    record.kind === "output" &&
    Object.keys(record).length === 3 &&
    typeof record.raw === "string" &&
    Array.isArray(record.optionIds) &&
    record.optionIds.every((id) => typeof id === "string")
  ) {
    return { kind: "output", raw: record.raw, optionIds: [...(record.optionIds as string[])] };
  }
  return null;
};

export type DecisionMakerOutputSubmission =
  | { status: "unknown_request" }
  | { status: "digest_key_unavailable" }
  | {
      status: "submitted";
      resultKind: DmResultKind;
      /** Why a DM output was not a proposal or an escalation; null otherwise. */
      validationFailure: DmOutputValidationFailure | null;
      resultDigest: string;
      result: DecisionMakerResultSubmission;
      /** The bodies this call stored: none unless the result was accepted now. */
      storedFields: DmBodyField[];
    };

/**
 * §6, §9, §10: a DM's output, validated here, digested by the app and
 * recorded as the request's terminal result, with its bodies stored in the
 * same transaction when the ledger accepts it.
 *
 * The result digest is computed here, under the request key, from the exact
 * output bytes submitted (or the fixed no-output marker of a timeout or an
 * unavailable DM) -- never taken from the caller -- so a resubmission of the
 * same output is the same (request, digest) pair the ledger answers
 * idempotently, and the broker, which holds K_R, can compute the pair to look
 * up a lost response. The output is checked with `validateDmOutput()` against
 * the request's option ids; a proposal stores its rationale (and a free-text
 * answer), an escalation its reason, and a validation failure nothing. A text
 * the validator passes but the body store cannot hold (a lone surrogate or a
 * NUL) is recorded as a schema validation failure. Bodies are written only
 * when the ledger accepted the result in this call: an existing pair already
 * has them, and a rejection -- a proposal under the kill switch included --
 * stores none.
 *
 * Statements: 1 request read -- 1 for an unknown request or a key the ring
 * does not hold; then the ledger's submission: 2 when it writes nothing, 3
 * when its switch read finds the store unreadable, 7 (8 with an integrity key)
 * for a result or a rejection; and 1 body insert for an accepted proposal or
 * escalation -- 9, or 10.
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
  let bodies: Array<{ field: DmBodyField; text: string }> = [];
  if (output.kind === "output") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.raw);
    } catch {
      parsed = undefined;
    }
    const verdict = validateDmOutput(parsed, output.optionIds);
    if (verdict.outcome === "validation_failure") {
      resultKind = "validation_failure";
      validationFailure = verdict.failure;
    } else {
      resultKind = verdict.outcome === "proposal" ? "proposal" : "escalate";
      bodies = dmOutputBodies(verdict.output);
      if (dmBodiesRefusal(bodies) !== null) {
        resultKind = "validation_failure";
        validationFailure = "schema";
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
  if (result.status !== "accepted" || bodies.length === 0) {
    return { status: "submitted", resultKind, validationFailure, resultDigest, result, storedFields: [] };
  }

  // The bodies name the result's own audit row, which the trigger requires to
  // be this transaction's `amux.decision.result` for this request's result
  // of the matching kind, and the period's registered key check.
  const ids = bodies.map(() => randomUUID());
  const stored = await tx.$queryRaw<Array<{ field: string }>>`
    INSERT INTO "AmuxDecisionMakerBody"
      ("id", "requestId", "field", "text", "keyPeriod", "keyCheck", "digest", "auditLogId")
    SELECT b."id", ${requestId}, b."field", b."text", ${keyPeriod}, ${dmDigestKeyCheck(periodKey)}, b."digest",
           ${result.event.auditLogId}
    FROM unnest(
      ${ids}::text[],
      ${bodies.map((body) => body.field)}::text[],
      ${bodies.map((body) => body.text)}::text[],
      ${bodies.map((body) => dmBodyDigest(requestKey, body.field, body.text))}::text[]
    ) AS b("id", "field", "text", "digest")
    RETURNING "field"
  `;
  return {
    status: "submitted",
    resultKind,
    validationFailure,
    resultDigest,
    result,
    storedFields: returnedFields(stored, bodies.map((body) => body.field)),
  };
}
