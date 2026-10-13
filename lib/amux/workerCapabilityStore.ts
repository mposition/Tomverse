import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AMUX_WORKER_CAPABILITY_AUDIT_ACTION,
  AMUX_WORKER_CAPABILITY_AUDIT_TARGET_TYPE,
  amuxWorkerCapabilityRefusal,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityRefusal,
} from "@/lib/amux/workerCapabilityCore";
import { isAmuxWorkerName } from "@/lib/amux/workerRegistryCore";
import { readAmuxWorkerRegistrationOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * The one module that reads and writes `AmuxWorkerCapabilityEvent`
 * (orchestration policy version 35, section 2). Nothing else in the
 * application names the table; `npm run check:protected-table-writers` fails
 * on another writer.
 *
 * Every function runs on a transaction its caller owns, and sends a fixed set
 * of statements -- pinned by tests/amuxWorkerCapabilityStore.test.mjs because
 * the AMUX DB boundary budgets them. The rules a stored event must satisfy are
 * the database's (migration 20261013100000_amux_worker_capability); this module
 * refuses the same cases first, so a refused write leaves no audit entry.
 * Permission is the caller's: the owner role and a recent step-up.
 */

type CapabilityReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export type AmuxWorkerCapabilityEntry = {
  workerName: string;
  revision: number;
  capability: AmuxWorkerCapability;
  changedAt: string;
};

type CapabilityRow = {
  workerName: string;
  revision: number;
  model: string | null;
  routingTags: string[];
  toolCapabilities: string[];
  v22Model: string | null;
  v22Roles: string[] | null;
  v22Tools: string[] | null;
  changedAtEpochMs?: bigint | number;
};

const capabilityFromRow = (row: CapabilityRow): AmuxWorkerCapability => ({
  model: row.model,
  routingTags: [...row.routingTags],
  toolCapabilities: [...row.toolCapabilities],
  v22: row.v22Model === null ? null : {
    model: row.v22Model,
    roles: [...(row.v22Roles ?? [])],
    tools: [...(row.v22Tools ?? [])],
  },
});

/**
 * The newest capability of every worker, in one statement. A statement that
 * fails is not caught; inside the boundary it has aborted the transaction.
 */
export async function readAmuxWorkerCapabilitiesOrThrow(
  client: CapabilityReader,
): Promise<Map<string, AmuxWorkerCapabilityEntry>> {
  const rows = await client.$queryRaw<CapabilityRow[]>`
    SELECT DISTINCT ON ("workerName")
      "workerName", "revision", "model", "routingTags", "toolCapabilities",
      "v22Model", "v22Roles", "v22Tools",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "changedAtEpochMs"
    FROM "AmuxWorkerCapabilityEvent"
    ORDER BY "workerName", "sequence" DESC
  `;
  const entries = new Map<string, AmuxWorkerCapabilityEntry>();
  for (const row of rows) {
    const changedAtMs = Number(row.changedAtEpochMs);
    const revision = Number(row.revision);
    const v22Parts = [row.v22Model, row.v22Roles, row.v22Tools].filter((part) => part !== null).length;
    if (!isAmuxWorkerName(row.workerName) || !Number.isSafeInteger(changedAtMs) ||
        !Number.isSafeInteger(revision) || revision < 1 ||
        !Array.isArray(row.routingTags) || row.routingTags.length === 0 || !Array.isArray(row.toolCapabilities) ||
        (v22Parts !== 0 && v22Parts !== 3) ||
        (row.v22Roles !== null && (!Array.isArray(row.v22Roles) || row.v22Roles.length === 0)) ||
        (row.v22Tools !== null && (!Array.isArray(row.v22Tools) || row.v22Tools.length === 0))) {
      throw new Error("AMUX worker capability row outside its shape");
    }
    entries.set(row.workerName, {
      workerName: row.workerName,
      revision,
      capability: capabilityFromRow(row),
      changedAt: new Date(changedAtMs).toISOString(),
    });
  }
  return entries;
}

export class AmuxWorkerCapabilityWriteError extends Error {
  readonly code: "invalid_change" | "no_operator" | "stale_revision" | "unreadable_registry" | AmuxWorkerCapabilityRefusal;

  constructor(code: AmuxWorkerCapabilityWriteError["code"]) {
    super(code);
    this.name = "AmuxWorkerCapabilityWriteError";
    this.code = code;
  }
}

export type AmuxWorkerCapabilityEventRecord = {
  eventId: string;
  auditLogId: string;
  workerName: string;
  revision: number;
  sequence: string;
  createdAt: string;
};

const stringList = (value: unknown, max: number): string[] | null =>
  Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string")
    ? [...value]
    : null;

/** A capability from untrusted input, or null when it is not that shape at all. */
export function parseAmuxWorkerCapabilityInput(value: unknown): AmuxWorkerCapability | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const routingTags = stringList(input.routingTags, 64);
  const toolCapabilities = stringList(input.toolCapabilities, 16);
  if (routingTags === null || toolCapabilities === null) return null;
  if (input.model !== null && typeof input.model !== "string") return null;
  let v22: AmuxWorkerCapability["v22"] = null;
  if (input.v22 !== null) {
    if (typeof input.v22 !== "object" || Array.isArray(input.v22)) return null;
    const profile = input.v22 as Record<string, unknown>;
    const roles = stringList(profile.roles, 4);
    const tools = stringList(profile.tools, 2);
    if (typeof profile.model !== "string" || roles === null || tools === null) return null;
    v22 = { model: profile.model, roles, tools };
  }
  return { model: input.model as string | null, routingTags, toolCapabilities, v22 };
}

/**
 * The owner records one worker's capability (version 35, section 2). In the
 * caller's transaction, in this order: the audit chain lock, the worker's
 * newest registry event, its newest capability revision, the refusal check,
 * the human audit `amux.worker.capability`, and the event naming it.
 *
 * Statements: 1 lock, 2 reads, the administrator writer's 3 (4 with an
 * integrity key), 1 insert -- 7, or 8. A refusal stops after the reads.
 */
export async function recordAmuxWorkerCapabilityByOwner(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request?: Request;
    workerName: unknown;
    expectedRevision: unknown;
    capability: unknown;
  },
): Promise<AmuxWorkerCapabilityEventRecord> {
  const capability = parseAmuxWorkerCapabilityInput(input.capability);
  const expectedRevision = input.expectedRevision;
  if (!isAmuxWorkerName(input.workerName) || capability === null ||
      typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new AmuxWorkerCapabilityWriteError("invalid_change");
  }
  const workerName = input.workerName;
  const actorUserId = input.session.user?.id;
  if (typeof actorUserId !== "string" || actorUserId.length === 0) {
    throw new AmuxWorkerCapabilityWriteError("no_operator");
  }

  await takeAuditChainLock(tx);
  let registration;
  try {
    registration = await readAmuxWorkerRegistrationOrThrow(tx, workerName);
  } catch (error) {
    if (error instanceof Error && error.message === "AMUX worker registry row outside its shape") {
      throw new AmuxWorkerCapabilityWriteError("unreadable_registry");
    }
    throw error;
  }
  const capabilityRows = await tx.$queryRaw<Array<{ revision: number }>>`
    SELECT "revision"
    FROM "AmuxWorkerCapabilityEvent"
    WHERE "workerName" = ${workerName}
    ORDER BY "sequence" DESC
    LIMIT 1
  `;
  const refusal = amuxWorkerCapabilityRefusal(registration, capability);
  if (refusal) throw new AmuxWorkerCapabilityWriteError(refusal);
  const currentRevision = Number(capabilityRows[0]?.revision ?? 0);
  if (expectedRevision !== currentRevision) throw new AmuxWorkerCapabilityWriteError("stale_revision");

  const revision = currentRevision + 1;
  const eventId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: AMUX_WORKER_CAPABILITY_AUDIT_ACTION,
    targetType: AMUX_WORKER_CAPABILITY_AUDIT_TARGET_TYPE,
    targetId: eventId,
    summary: "Recorded an AMUX worker's capability.",
    metadata: {
      event_id: eventId,
      worker_name: workerName,
      revision,
      model: capability.model,
      routing_tags: capability.routingTags,
      tool_capabilities: capability.toolCapabilities,
      v22_model: capability.v22?.model ?? null,
      v22_roles: capability.v22?.roles ?? null,
      v22_tools: capability.v22?.tools ?? null,
    },
    tx,
  });
  const v22 = capability.v22;
  const inserted = await tx.$queryRaw<Array<{ sequence: bigint | number | string; createdAtEpochMs: bigint | number }>>`
    INSERT INTO "AmuxWorkerCapabilityEvent"
      ("id", "workerName", "revision", "model", "routingTags", "toolCapabilities",
       "v22Model", "v22Roles", "v22Tools", "actorUserId", "auditLogId")
    VALUES
      (${eventId}, ${workerName}, ${revision}, ${capability.model},
       ${capability.routingTags}::text[], ${capability.toolCapabilities}::text[],
       ${v22?.model ?? null}, ${v22 ? v22.roles : null}::text[], ${v22 ? v22.tools : null}::text[],
       ${actorUserId}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  const row = inserted[0];
  if (!row) throw new Error("AMUX worker capability insert returned no row");
  const createdAtMs = Number(row.createdAtEpochMs);
  if (!Number.isSafeInteger(createdAtMs)) throw new Error("AMUX worker capability clock is not a safe integer");
  return {
    eventId,
    auditLogId,
    workerName,
    revision,
    sequence: String(row.sequence),
    createdAt: new Date(createdAtMs).toISOString(),
  };
}
