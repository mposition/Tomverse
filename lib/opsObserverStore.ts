/**
 * The sre-ops agent's store: the one module that reads and writes the
 * ops-observer tables (docs/policy/sre-ops.md §3 rules 4, 7 and 10).
 *
 * This slice is the state read. One `state_read` transaction gathers the
 * facts the trust check judges -- the genesis head and its approval, the state
 * row and the database's own recomputation of its key stamp, the catalogue of
 * the agent's rules, the transition ledger since the verified checkpoint with
 * the audit entries it names, and the open reservation -- and judges them with
 * the pure cores. Anything but `trusted` returns only the reason: no keys, no
 * generation, nothing a caller could act on (§3 rule 7).
 *
 * Every statement is a tagged single-statement raw query through the counted
 * client, so the read is bounded by the kind's statement ceiling. The audit
 * HMACs are verified here, in the app, with the integrity keys; the services
 * never hold them.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeys,
} from "@/lib/adminAuditIntegrityCore";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { type OpsObserverClient, withOpsObserverTransaction } from "@/lib/opsObserverTransaction";
import {
  OPS_OBSERVER_OWN_TABLES,
  OPS_OBSERVER_SHARED_TABLES,
  catalogProblems,
} from "@/scripts/ops-observer/catalog-core.mjs";
import { keysAreValid } from "@/scripts/ops-observer/keys-schema-core.mjs";
import { transitionVerdict } from "@/scripts/ops-observer/transition-verdict-core.mjs";
import { judgeTrust } from "@/scripts/ops-observer/trust-check-core.mjs";

type HeadRow = {
  id: string;
  createdAt: Date;
  mode: string;
  requestDigest: string;
  supersedesGenesisId: string | null;
  previousCreatedAt: Date | null;
  stateGenesisId: string | null;
  generation: number | null;
  keys: unknown;
  invariantVersion: number | null;
  stampGeneration: number | null;
  stampKeysSha256: string | null;
  verifiedThroughGeneration: number | null;
  verifiedThroughAuditId: string | null;
  verifiedThroughAuditHash: string | null;
  stampCheckpointSha256: string | null;
  recomputedKeysSha256: string | null;
  recomputedCheckpointSha256: string | null;
};

type AuditRow = {
  id: string;
  previousHash: string | null;
  entryHash: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAtIso: string;
};

export type OpsObserverStateRead =
  | {
      trust: "trusted";
      genesisId: string;
      mode: string;
      generation: number;
      keys: Record<string, unknown>;
      reservedOpen: boolean;
    }
  | { trust: string };

/** Whether an audit row's own HMAC verifies under any integrity key and key order. */
export function auditRowHashVerified(row: AuditRow, keys: string[]): boolean {
  if (!row.entryHash) return false;
  const input = {
    previousHash: row.previousHash,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    metadata: row.metadata ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAtIso,
  };
  return keys.some((key) => {
    const variants = adminAuditEntryHashVariants(input, key);
    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some((order) => variants[order] === row.entryHash);
  });
}

const judgedAudit = (row: AuditRow, keys: string[]) => ({
  ...row,
  actorKind: auditRowActorKind({ ...row, metadata: row.metadata as never }),
  hashVerified: auditRowHashVerified(row, keys),
});

async function gatherFacts(tx: OpsObserverClient, integrityKeys: string[]) {
  // 1. The genesis head (the one nobody replaced), its predecessor's time, its
  //    state row, and both stamps recomputed the way the state trigger does.
  const heads = await tx.$queryRaw<HeadRow[]>`
    SELECT g.id, g."createdAt", g.mode, g."requestDigest", g."supersedesGenesisId",
           p."createdAt" AS "previousCreatedAt",
           s."genesisId" AS "stateGenesisId", s.generation, s.keys, s."invariantVersion",
           s."stampGeneration", s."stampKeysSha256", s."verifiedThroughGeneration",
           s."verifiedThroughAuditId", s."verifiedThroughAuditHash", s."stampCheckpointSha256",
           encode(sha256(convert_to(s.keys::text, 'UTF8')), 'hex') AS "recomputedKeysSha256",
           encode(sha256(convert_to(
             s."verifiedThroughGeneration"::text || ':' || coalesce(s."verifiedThroughAuditId", '') || ':' ||
             coalesce(s."verifiedThroughAuditHash", ''), 'UTF8')), 'hex') AS "recomputedCheckpointSha256"
      FROM "OpsObserverGenesis" g
      LEFT JOIN "OpsObserverGenesis" p ON p.id = g."supersedesGenesisId"
      LEFT JOIN "OpsObserverState" s ON s."genesisId" = g.id
     WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" x WHERE x."supersedesGenesisId" = g.id)
     LIMIT 2`;
  // No genesis, or a chain with two heads, is not a state anyone can trust.
  const head = heads.length === 1 ? heads[0] : null;
  const base = { auditKeyCount: integrityKeys.length };
  if (!head || head.stateGenesisId === null) {
    return { facts: { ...base, genesis: null, state: null }, head: null };
  }

  // 2. The human approval of this genesis.
  const genesisAudit = await tx.$queryRaw<AuditRow[]>`
    SELECT id, "previousHash", "entryHash", "actorUserId", "actorEmail", action, "targetType",
           "targetId", summary, metadata, "ipAddress", "userAgent",
           to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAtIso"
      FROM "AdminAuditLog"
     WHERE "targetType" = 'OpsObserverGenesis' AND "targetId" = ${head.id}
       AND action = 'ops_observer.genesis_created'
     LIMIT 2`;

  // 3-5. The catalogue of the agent's tables and the shared ones it writes.
  const tables = [...OPS_OBSERVER_OWN_TABLES, ...OPS_OBSERVER_SHARED_TABLES];
  const triggers = await tx.$queryRaw<unknown[]>`
    SELECT c.relname AS "table", n.nspname AS "tableSchema", t.tgname AS name, t.tgenabled::text AS enabled,
           p.proname AS "functionName", pn.nspname AS "functionSchema",
           t.tgdeferrable AS deferrable, t.tginitdeferred AS "initiallyDeferred"
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = ANY(${tables}::text[]) AND NOT t.tgisinternal`;
  const constraints = await tx.$queryRaw<unknown[]>`
    SELECT c.relname AS "table", k.conname AS name, k.contype::text AS type,
           k.condeferrable AS deferrable, k.condeferred AS "initiallyDeferred"
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = ANY(${tables}::text[])`;
  const indexes = await tx.$queryRaw<unknown[]>`
    SELECT tablename AS "table", indexname AS name FROM pg_catalog.pg_indexes
     WHERE schemaname = current_schema() AND tablename = ANY(${[...OPS_OBSERVER_OWN_TABLES]}::text[])`;

  // 6-7. The ledger from the checkpoint generation through the generation read
  //      above -- never past it, so an advance committed meanwhile is not read as
  //      a row out of range -- and the entries it names. Not capped: a cap would
  //      cut a healthy chain. What keeps the range short is that every advance
  //      moves the checkpoint to the generation before it, in the same
  //      transaction, so it is one or two rows.
  const checkpoint = head.verifiedThroughGeneration ?? 0;
  const through = head.generation ?? 0;
  const ledgerRows = await tx.$queryRaw<
    { generation: number; auditLogId: string; auditEntryHash: string; keysSha256: string }[]
  >`
    SELECT generation, "auditLogId", "auditEntryHash", "keysSha256"
      FROM "OpsObserverTransition"
     WHERE "genesisId" = ${head.id}::uuid AND generation >= ${Math.max(1, checkpoint)} AND generation <= ${through}
     ORDER BY generation`;
  const ledgerAudit =
    ledgerRows.length === 0
      ? []
      : await tx.$queryRaw<AuditRow[]>`
          SELECT id, "previousHash", "entryHash", "actorUserId", "actorEmail", action, "targetType",
                 "targetId", summary, metadata, "ipAddress", "userAgent",
                 to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAtIso"
            FROM "AdminAuditLog"
           WHERE id = ANY(${ledgerRows.map((row) => row.auditLogId)}::text[])`;

  // 8. The open reservation of this genesis, if any.
  const deliveries = await tx.$queryRaw<
    { invariantVersion: number; status: string; stampStatus: string; mode: string }[]
  >`
    SELECT "invariantVersion", status, "stampStatus", mode
      FROM "OpsObserverDelivery"
     WHERE "genesisId" = ${head.id}::uuid AND status = 'reserved'`;

  const state = {
    genesisId: head.stateGenesisId,
    generation: head.generation,
    invariantVersion: head.invariantVersion,
    stampGeneration: head.stampGeneration,
    stampKeysSha256: head.stampKeysSha256,
    verifiedThroughGeneration: checkpoint,
    verifiedThroughAuditId: head.verifiedThroughAuditId,
    verifiedThroughAuditHash: head.verifiedThroughAuditHash,
    stampCheckpointSha256: head.stampCheckpointSha256,
  };
  return {
    head,
    deliveries,
    facts: {
      ...base,
      genesis: {
        id: head.id,
        createdAt: head.createdAt,
        mode: head.mode,
        requestDigest: head.requestDigest,
        supersedesGenesisId: head.supersedesGenesisId,
      },
      previousGenesisCreatedAt: head.previousCreatedAt,
      state,
      genesisAuditRows: genesisAudit.map((row) => judgedAudit(row, integrityKeys)),
      keysSchemaValid: keysAreValid(head.keys),
      catalogComplete: catalogProblems({ triggers, constraints, indexes }).length === 0,
      recomputedKeysSha256: head.recomputedKeysSha256,
      recomputedCheckpointSha256: head.recomputedCheckpointSha256,
      transitionVerdict: transitionVerdict({
        state,
        ledgerRows,
        auditRows: ledgerAudit.map((row) => judgedAudit(row, integrityKeys)),
      }),
      deliveries,
    },
  };
}

/**
 * Reads the ops-observer state for a run whose deadline is `runDeadline`.
 * Trusted: the genesis, mode, generation, keys and whether a reservation is
 * still open. Otherwise: the trust reason only.
 */
export async function readOpsObserverState(
  runDeadline: Date,
  client: PrismaClient = prisma,
): Promise<OpsObserverStateRead> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  const { result } = await withOpsObserverTransaction(
    "state_read",
    runDeadline,
    async (tx) => {
      const gathered = await gatherFacts(tx, integrityKeys);
      const verdict = judgeTrust(gathered.facts) as { trusted: boolean; reason?: string };
      if (!verdict.trusted || !gathered.head) return { trust: verdict.reason ?? "state_missing" };
      return {
        trust: "trusted" as const,
        genesisId: gathered.head.id,
        mode: gathered.head.mode,
        generation: gathered.head.generation as number,
        keys: gathered.head.keys as Record<string, unknown>,
        reservedOpen: gathered.deliveries.length > 0,
      };
    },
    client,
  );
  return result;
}
