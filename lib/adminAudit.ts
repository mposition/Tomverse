import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { getTrustedClientIp } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import {
  adminAuditIntegrityKeys,
  computeAdminAuditEntryHash,
} from "@/lib/adminAuditIntegrityCore";
import {
  SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  isSystemAuditActor,
  metadataClaimsSystemActor,
  type SystemAuditActor,
} from "@/lib/adminAuditSystemActors";

type AuditInput = {
  session: Session;
  request?: Request;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;
  /**
   * Writes the entry inside a transaction the caller already owns, instead of
   * opening one here.
   *
   * Use this when the audit row has to commit or roll back with the change it
   * describes. A separate transaction means an action can succeed with no
   * record of who took it -- which is exactly the failure the refund decision
   * path had.
   *
   * Two constraints come with it. The chain's advisory lock is transaction
   * scoped, so it is held until the *caller's* transaction ends: only pass a
   * transaction that is short and does no external I/O, or audit writes across
   * the process will queue behind it. And a caller that rolls back after this
   * returns silently discards the entry, which is the point -- the action is
   * discarded too.
   */
  tx?: Prisma.TransactionClient;
};

const safeSummary = (value: string) => value.trim().slice(0, 500);

/**
 * One entry as it is about to be chained: every value already normalized, so
 * the function below hashes and stores exactly what it is given.
 */
type AuditChainEntry = {
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: Prisma.InputJsonValue | null | undefined;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * Appends one entry to the audit hash chain on `client`.
 *
 * The application's shared append path. Every writer -- the administrator
 * writer below and any system-actor writer -- goes through here, so the lock,
 * the database clock, the previous-hash read and the HMAC input cannot drift
 * apart between them (docs/policy/marketing-automation.md §6). The sequence is
 * pinned by tests/server-contract/admin-audit-chain-writer.test.ts. It is the
 * intended way in, not a boundary: what stops other writes is the static check
 * and the database's own triggers, within the limits both state.
 *
 * `integritySecret` is resolved by the caller before any transaction opens,
 * as it always was, so reading the environment is not part of the locked span.
 */
/**
 * Takes the audit chain's transaction-scoped advisory lock.
 *
 * `appendAuditChainEntry()` below takes it as its first statement, which is
 * enough when the append is the first thing a transaction does. It is not
 * enough when the append is the last: a transaction that locks rows and then
 * appends takes the two locks in the opposite order from one that appends and
 * then locks rows, and two of those running at once deadlock.
 *
 * So a caller whose audit entry must come last -- because it names a row it is
 * creating -- calls this first instead. The lock is re-entrant within a
 * transaction and released at commit, so the append's own request costs
 * nothing; what it buys is that every writer takes this lock before any row
 * lock, which is the only ordering there is.
 */
export async function takeAuditChainLock(
  client: Prisma.TransactionClient,
): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`;
}

async function appendAuditChainEntry(
  client: Prisma.TransactionClient,
  entry: AuditChainEntry,
  integritySecret: string | undefined
): Promise<string> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`;
  const timestampRows = await client.$queryRaw<Array<{ createdAt: Date }>>`
    -- AdminAuditLog.createdAt is a naive timestamp. Always materialize the
    -- UTC wall clock explicitly so a non-UTC database session cannot shift
    -- the stored instant or the HMAC payload derived from it.
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "createdAt"
  `;
  const databaseNow = timestampRows[0]?.createdAt || new Date();
  const previous = integritySecret
    ? await client.adminAuditLog.findFirst({
        where: { entryHash: { not: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { entryHash: true, createdAt: true },
      })
    : null;
  // The chain is ordered by (createdAt, id) and ids are random, so an entry
  // stamped in the same millisecond as the head could sort before it and fork
  // the chain for the next writer. A hashed entry therefore always lands at
  // least one millisecond after the head; the database refuses anything else
  // (20260918090000_admin_audit_log_append_only).
  const createdAt =
    previous && databaseNow.getTime() <= previous.createdAt.getTime()
      ? new Date(previous.createdAt.getTime() + 1)
      : databaseNow;
  const previousHash = previous?.entryHash || null;
  const entryHash = integritySecret
    ? computeAdminAuditEntryHash(
        {
          previousHash,
          actorUserId: entry.actorUserId,
          actorEmail: entry.actorEmail,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          summary: entry.summary,
          metadata: entry.metadata || null,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          createdAt: createdAt.toISOString(),
        },
        integritySecret
      )
    : null;
  const created = await client.adminAuditLog.create({
    select: { id: true },
    data: {
      actorUserId: entry.actorUserId,
      actorEmail: entry.actorEmail,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: entry.summary,
      metadata: entry.metadata || undefined,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      previousHash,
      entryHash,
      createdAt,
    },
  });
  return created.id;
}

/**
 * Thrown when a writer is called in a way that would record the wrong actor or
 * leave the entry outside the caller's transaction. A programming error, never
 * a condition to retry.
 */
export class AuditWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditWriteRefusedError";
  }
}

const refuseReservedMetadata = (metadata: unknown) => {
  if (metadataClaimsSystemActor(metadata)) {
    throw new AuditWriteRefusedError(
      `Audit metadata may not set "${SYSTEM_AUDIT_ACTOR_METADATA_KEY}"; only writeSystemAuditLog records a system actor.`
    );
  }
};

export async function writeAdminAuditLog({
  session,
  request,
  action,
  targetType,
  targetId,
  summary,
  metadata,
  tx,
}: AuditInput): Promise<string> {
  // Checked before anything is read or locked: a refused entry costs nothing.
  refuseReservedMetadata(metadata);
  const entry: AuditChainEntry = {
    actorUserId: session.user?.id || null,
    actorEmail: session.user?.email || null,
    action,
    targetType,
    targetId: targetId || null,
    summary: safeSummary(summary),
    metadata,
    ipAddress: request ? getTrustedClientIp(request) : null,
    userAgent: request?.headers.get("user-agent")?.slice(0, 500) || null,
  };
  // The first key, never a historical one: `ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS`
  // exists so old entries can still be *verified*, and signing a new entry with
  // a retired key would put fresh rows in a span that is on its way out.
  const integritySecret = adminAuditIntegrityKeys(process.env)[0];
  const write = (client: Prisma.TransactionClient) =>
    appendAuditChainEntry(client, entry, integritySecret);

  // The id is returned so a caller can name this entry as evidence in the same
  // transaction (docs/policy/email-product-news-redesign-draft.md, section 7.4).
  if (tx) return write(tx);
  return prisma.$transaction(write);
}

type SystemAuditInput = {
  /**
   * Required, unlike the administrator writer's. A system action has no
   * request to fail and no person to ask, so its record has to commit or roll
   * back with the change it describes (docs/policy/marketing-automation.md §6).
   */
  tx: Prisma.TransactionClient;
  systemActor: SystemAuditActor;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  /** An object, because the writer adds the actor marker to it. */
  metadata?: Prisma.InputJsonObject | null;
};

/**
 * Records an action taken by the system rather than by an administrator.
 *
 * Same chain, same lock, same hash as `writeAdminAuditLog` -- both go through
 * `appendAuditChainEntry`. The entry has no actor id, email, IP or user agent;
 * `metadata.systemActor` names which listed system actor wrote it
 * (`lib/adminAuditSystemActors.ts`).
 *
 * Everything is checked at runtime as well as by the types, because callers
 * reach this from jobs whose inputs are assembled at runtime.
 */
export async function writeSystemAuditLog({
  tx,
  systemActor,
  action,
  targetType,
  targetId,
  summary,
  metadata,
}: SystemAuditInput): Promise<string> {
  if (!tx) {
    throw new AuditWriteRefusedError(
      "writeSystemAuditLog needs the caller's transaction."
    );
  }
  if (!isSystemAuditActor(systemActor)) {
    throw new AuditWriteRefusedError(
      "writeSystemAuditLog was given a system actor that is not listed."
    );
  }
  if (
    metadata !== undefined &&
    metadata !== null &&
    (typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new AuditWriteRefusedError(
      "writeSystemAuditLog metadata must be an object."
    );
  }
  refuseReservedMetadata(metadata);

  const entry: AuditChainEntry = {
    actorUserId: null,
    actorEmail: null,
    action,
    targetType,
    targetId: targetId || null,
    summary: safeSummary(summary),
    metadata: { ...(metadata || {}), [SYSTEM_AUDIT_ACTOR_METADATA_KEY]: systemActor },
    ipAddress: null,
    userAgent: null,
  };
  const integritySecret = adminAuditIntegrityKeys(process.env)[0];
  return appendAuditChainEntry(tx, entry, integritySecret);
}
