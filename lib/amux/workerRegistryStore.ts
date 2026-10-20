import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AMUX_WORKER_REGISTRY_AUDIT_TARGET_TYPE,
  amuxWorkerRegistrationFromRow,
  amuxWorkerRegistryAuditAction,
  amuxWorkerRegistryAuditMetadata,
  amuxWorkerRegistryChangeRefusal,
  isAmuxWorkerLatchEventKind,
  isAmuxWorkerName,
  isAmuxWorkerObservationStatus,
  parseAmuxWorkerRegistryChange,
  type AmuxWorkerLatchEventKind,
  type AmuxWorkerObservationStatus,
  type AmuxWorkerRegistration,
  type AmuxWorkerRegistryRefusal,
} from "@/lib/amux/workerRegistryCore";

/**
 * The one module that reads and writes `AmuxWorkerRegistryEvent`, and the one
 * that reads `AmuxWorkerObservation` and `AmuxWorkerLatchEvent`
 * (orchestration policy version 31, sections 3, 4 and 7). Nothing else in the
 * application names those tables; `npm run check:protected-table-writers`
 * fails on another writer.
 *
 * Every function runs on a transaction its caller owns. The statements each
 * one sends are fixed -- no loop -- and pinned by
 * tests/amuxWorkerRegistryStore.test.mjs, because the AMUX DB boundary budgets
 * them (`AMUX_DB_BOUNDARIES.workerRegistryRead`, `.workerRegistryChange`).
 *
 * The rules a stored event must satisfy are the database's (migration
 * 20261012100000_amux_worker_registry, its guard body replaced by
 * 20261020200000_amux_worker_registry_direct_activation); this module
 * refuses the same cases first, so a refused change writes no audit entry.
 * Permission is the caller's: the owner role and a recent step-up (section
 * 3), checked before this is called.
 */

type RegistryReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export type AmuxWorkerRegistryEntry = AmuxWorkerRegistration & {
  /** The database clock of the newest event, ISO 8601. */
  changedAt: string;
};

export type AmuxWorkerRegistryView = {
  /** Null when any stored row is one the guard would not have accepted. */
  registrations: AmuxWorkerRegistryEntry[] | null;
  /** The newest latch event of each worker that has one. */
  latches: Map<string, AmuxWorkerLatchEventKind>;
  /** The newest observation of each worker that has one. */
  observations: Map<string, AmuxWorkerObservationStatus>;
};

const epochMs = (value: unknown): number | null => {
  const ms = typeof value === "bigint" ? Number(value) : value;
  return typeof ms === "number" && Number.isSafeInteger(ms) ? ms : null;
};

/**
 * The newest registry event of every worker, the newest latch event and the
 * newest observation of each, in three statements. A statement that fails is
 * not caught: inside the boundary it has aborted the transaction, and the
 * caller must learn the read failed rather than act on a partial view. A
 * latch or observation row outside its vocabulary throws for the same reason:
 * a latch that cannot be read is never "closed".
 */
export async function readAmuxWorkerRegistryOrThrow(
  client: RegistryReader,
): Promise<AmuxWorkerRegistryView> {
  const registryRows = await client.$queryRaw<
    Array<{
      workerName: string;
      providerClass: string;
      roleCeiling: string;
      desiredState: string;
      revision: number;
      changedAtEpochMs: bigint;
    }>
  >`
    SELECT DISTINCT ON ("workerName")
      "workerName", "providerClass", "roleCeiling", "desiredState", "revision",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "changedAtEpochMs"
    FROM "AmuxWorkerRegistryEvent"
    ORDER BY "workerName", "sequence" DESC
  `;
  const latchRows = await client.$queryRaw<Array<{ workerName: string; eventKind: string }>>`
    SELECT DISTINCT ON ("workerName") "workerName", "eventKind"
    FROM "AmuxWorkerLatchEvent"
    ORDER BY "workerName", "sequence" DESC
  `;
  const observationRows = await client.$queryRaw<Array<{ workerName: string; status: string }>>`
    SELECT DISTINCT ON ("workerName") "workerName", "status"
    FROM "AmuxWorkerObservation"
    ORDER BY "workerName", "sequence" DESC
  `;

  let registrations: AmuxWorkerRegistryEntry[] | null = [];
  for (const row of registryRows) {
    const registration = amuxWorkerRegistrationFromRow(row);
    const changedAtMs = epochMs(row.changedAtEpochMs);
    if (registration === null || changedAtMs === null) {
      registrations = null;
      break;
    }
    registrations.push({ ...registration, changedAt: new Date(changedAtMs).toISOString() });
  }

  const latches = new Map<string, AmuxWorkerLatchEventKind>();
  for (const row of latchRows) {
    if (!isAmuxWorkerName(row.workerName) || !isAmuxWorkerLatchEventKind(row.eventKind)) {
      throw new Error("AMUX worker latch row outside its vocabulary");
    }
    latches.set(row.workerName, row.eventKind);
  }
  const observations = new Map<string, AmuxWorkerObservationStatus>();
  for (const row of observationRows) {
    if (!isAmuxWorkerName(row.workerName) || !isAmuxWorkerObservationStatus(row.status)) {
      throw new Error("AMUX worker observation row outside its vocabulary");
    }
    observations.set(row.workerName, row.status);
  }
  return { registrations, latches, observations };
}

/**
 * Version 35 section 3: the newest registry event and the newest latch event
 * of every worker, as JSON-array subqueries that the assignment catalog
 * reader composes into its one statement. The text stays in this store, the
 * one module that reads these tables; the composing module names no table.
 */
export const amuxWorkerRegistryNewestJsonSql = (): Prisma.Sql => Prisma.sql`(
  SELECT coalesce(json_agg(newest), '[]'::json) FROM (
    SELECT DISTINCT ON ("workerName")
      "workerName", "providerClass", "roleCeiling", "desiredState", "revision"
    FROM "AmuxWorkerRegistryEvent"
    ORDER BY "workerName", "sequence" DESC
  ) AS newest
)`;

export const amuxWorkerLatchNewestJsonSql = (): Prisma.Sql => Prisma.sql`(
  SELECT coalesce(json_agg(newest), '[]'::json) FROM (
    SELECT DISTINCT ON ("workerName") "workerName", "eventKind"
    FROM "AmuxWorkerLatchEvent"
    ORDER BY "workerName", "sequence" DESC
  ) AS newest
)`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * What those two subqueries return, under this store's own rules: a registry
 * row the guard would not have accepted makes the registrations null, as
 * `readAmuxWorkerRegistryOrThrow()` does; a latch row outside its vocabulary,
 * or a value that is not a list of rows, throws -- a latch that cannot be read
 * is never "closed".
 */
export function amuxWorkerRegistryFromNewestJsonOrThrow(
  registry: unknown,
  latches: unknown,
): { registrations: AmuxWorkerRegistration[] | null; latches: Map<string, AmuxWorkerLatchEventKind> } {
  if (!Array.isArray(registry) || !Array.isArray(latches)) {
    throw new Error("AMUX worker registry read outside its shape");
  }
  let registrations: AmuxWorkerRegistration[] | null = [];
  for (const row of registry) {
    const registration = isRecord(row)
      ? amuxWorkerRegistrationFromRow({
          workerName: row.workerName,
          providerClass: row.providerClass,
          roleCeiling: row.roleCeiling,
          desiredState: row.desiredState,
          revision: row.revision,
        })
      : null;
    if (registration === null) {
      registrations = null;
      break;
    }
    registrations.push(registration);
  }
  const latchKinds = new Map<string, AmuxWorkerLatchEventKind>();
  for (const row of latches) {
    if (!isRecord(row) || !isAmuxWorkerName(row.workerName) || !isAmuxWorkerLatchEventKind(row.eventKind)) {
      throw new Error("AMUX worker latch row outside its vocabulary");
    }
    latchKinds.set(row.workerName, row.eventKind);
  }
  return { registrations, latches: latchKinds };
}

/**
 * One worker's newest registry event, in one statement, for another store's
 * writer in the same transaction (the capability store checks the ceiling
 * with it). Null when the worker has none; a row the guard would not have
 * accepted throws, so the caller never acts on it.
 */
export async function readAmuxWorkerRegistrationOrThrow(
  client: RegistryReader,
  workerName: string,
): Promise<AmuxWorkerRegistration | null> {
  const rows = await client.$queryRaw<
    Array<{ workerName: string; providerClass: string; roleCeiling: string; desiredState: string; revision: number }>
  >`
    SELECT "workerName", "providerClass", "roleCeiling", "desiredState", "revision"
    FROM "AmuxWorkerRegistryEvent"
    WHERE "workerName" = ${workerName}
    ORDER BY "sequence" DESC
    LIMIT 1
  `;
  if (!rows[0]) return null;
  const registration = amuxWorkerRegistrationFromRow(rows[0]);
  if (registration === null) throw new Error("AMUX worker registry row outside its shape");
  return registration;
}

export class AmuxWorkerRegistryWriteError extends Error {
  readonly code: "invalid_change" | "no_operator" | "unreadable_previous" | AmuxWorkerRegistryRefusal;

  constructor(code: AmuxWorkerRegistryWriteError["code"]) {
    super(code);
    this.name = "AmuxWorkerRegistryWriteError";
    this.code = code;
  }
}

export type AmuxWorkerRegistryEventRecord = {
  eventId: string;
  auditLogId: string;
  action: string;
  workerName: string;
  revision: number;
  /** The database's sequence, as a decimal string (it is a BIGINT). */
  sequence: string;
  createdAt: string;
};

/**
 * The owner records one worker's desired state and role ceiling (section 3).
 * In the caller's transaction, in this order: the audit chain lock (so no
 * other registry event or audit entry commits between the read and the
 * insert), the worker's newest event, the refusal check, the human audit
 * (`amux.worker.register` for a new worker, `amux.worker.change` after), and
 * the event naming that audit row.
 *
 * Statements: 1 lock, 1 read, the administrator writer's 3 (4 with an
 * integrity key), 1 insert -- 6, or 7. A refusal stops after the read.
 */
export async function recordAmuxWorkerRegistryChangeByOwner(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request?: Request;
    workerName: unknown;
    roleCeiling: unknown;
    desiredState: unknown;
    expectedRevision: unknown;
  },
): Promise<AmuxWorkerRegistryEventRecord> {
  const change = parseAmuxWorkerRegistryChange(input);
  if (!change) throw new AmuxWorkerRegistryWriteError("invalid_change");
  const actorUserId = input.session.user?.id;
  if (typeof actorUserId !== "string" || actorUserId.length === 0) {
    throw new AmuxWorkerRegistryWriteError("no_operator");
  }

  await takeAuditChainLock(tx);
  const newest = await tx.$queryRaw<
    Array<{ workerName: string; providerClass: string; roleCeiling: string; desiredState: string; revision: number }>
  >`
    SELECT "workerName", "providerClass", "roleCeiling", "desiredState", "revision"
    FROM "AmuxWorkerRegistryEvent"
    WHERE "workerName" = ${change.workerName}
    ORDER BY "sequence" DESC
    LIMIT 1
  `;
  let previous: AmuxWorkerRegistration | null = null;
  if (newest[0]) {
    previous = amuxWorkerRegistrationFromRow(newest[0]);
    if (previous === null) throw new AmuxWorkerRegistryWriteError("unreadable_previous");
  }
  const refusal = amuxWorkerRegistryChangeRefusal(previous, change);
  if (refusal) throw new AmuxWorkerRegistryWriteError(refusal);

  const action = amuxWorkerRegistryAuditAction(previous);
  const revision = change.expectedRevision + 1;
  const eventId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action,
    targetType: AMUX_WORKER_REGISTRY_AUDIT_TARGET_TYPE,
    targetId: eventId,
    summary: previous === null ? "Registered an AMUX worker." : "Changed an AMUX worker's registration.",
    metadata: amuxWorkerRegistryAuditMetadata(previous, change, eventId),
    tx,
  });
  const inserted = await tx.$queryRaw<Array<{ sequence: bigint | number | string; createdAtEpochMs: bigint | number }>>`
    INSERT INTO "AmuxWorkerRegistryEvent"
      ("id", "workerName", "providerClass", "roleCeiling", "desiredState", "revision", "actorUserId", "auditLogId")
    VALUES
      (${eventId}, ${change.workerName}, ${change.providerClass}, ${change.roleCeiling},
       ${change.desiredState}, ${revision}, ${actorUserId}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  const row = inserted[0];
  if (!row) throw new Error("AMUX worker registry insert returned no row");
  const createdAtMs = epochMs(row.createdAtEpochMs);
  if (createdAtMs === null) throw new Error("AMUX worker registry clock is not a safe integer");
  return {
    eventId,
    auditLogId,
    action,
    workerName: change.workerName,
    revision,
    sequence: String(row.sequence),
    createdAt: new Date(createdAtMs).toISOString(),
  };
}
