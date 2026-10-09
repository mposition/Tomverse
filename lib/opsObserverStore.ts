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

import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Session } from "next-auth";

import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeys,
} from "@/lib/adminAuditIntegrityCore";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { type OpsObserverClient, assertNotLate, withOpsObserverTransaction } from "@/lib/opsObserverTransaction";
import {
  OPS_OBSERVER_OWN_TABLES,
  OPS_OBSERVER_SHARED_TABLES,
  catalogProblems,
} from "@/scripts/ops-observer/catalog-core.mjs";
import { keysAreValid } from "@/scripts/ops-observer/keys-schema-core.mjs";
import { transitionVerdict } from "@/scripts/ops-observer/transition-verdict-core.mjs";
import { incidentOrigin, owedMessages, reservationIsOwed } from "@/scripts/ops-observer/advance-request-core.mjs";
import { admitOwedItems } from "@/scripts/ops-observer/notification-budget-core.mjs";
import { DELIVERY_RETENTION_DAYS, confirmStatusForMode } from "@/scripts/ops-observer/delivery-core.mjs";
import { GENESIS_MIN_INTERVAL_MS, deliveryStampReason, judgeTrust } from "@/scripts/ops-observer/trust-check-core.mjs";
import { OPS_OBSERVER_INVARIANT_VERSION, genesisRefusal } from "@/scripts/ops-observer/genesis-core.mjs";
import { S2_PAGE_KEYS, initialKeyState } from "@/scripts/ops-observer/classify-core.mjs";
import { AUDIT_APPEND_STATEMENT_COST } from "@/scripts/ops-observer/statement-ceiling-core.mjs";

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
      /** Present when the read named an owner date (see readOpsObserverState). */
      budget?: OpsObserverDailyBudget;
    }
  | { trust: string };

/**
 * What a genesis has already reserved on one owner date (policy §5): every
 * reserved item as the cap counts it, and whether that date's channel check
 * is taken. The advance counts the same rows inside its own transaction and
 * refuses a reservation over the cap; with these a run can keep to it first.
 */
export type OpsObserverDailyBudget = {
  ownerDate: string;
  reservedToday: { key: string; kind: string; capped: boolean }[];
  channelCheckTaken: boolean;
};

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
    // The genesis head without its state is not trusted, but it is still the
    // head a recovery must name and supersede.
    return { facts: { ...base, genesis: null, state: null }, head: null, chainHead: head, ledgerRows: [], deliveries: [] };
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
    chainHead: head,
    deliveries,
    ledgerRows,
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
 * still open, and -- when `ownerDate` is given -- that date's budget, read in
 * the same transaction with the same queries the advance counts with.
 * Otherwise: the trust reason only.
 *
 * A read writes nothing, so no deferred deadline check runs at its COMMIT;
 * the answer is returned only after the separate short check confirms the
 * run is not past its deadline (policy §6 item 5), and a late run gets
 * OpsObserverLateError instead of a state it could act on.
 */
export async function readOpsObserverState(
  runDeadline: Date,
  client: PrismaClient = prisma,
  ownerDate: string | null = null,
): Promise<OpsObserverStateRead> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  const { result } = await withOpsObserverTransaction(
    "state_read",
    runDeadline,
    async (tx) => {
      const gathered = await gatherFacts(tx, integrityKeys);
      const verdict = judgeTrust(gathered.facts) as { trusted: boolean; reason?: string };
      if (!verdict.trusted || !gathered.head) return { trust: verdict.reason ?? "state_missing" };
      const state = {
        trust: "trusted" as const,
        genesisId: gathered.head.id,
        mode: gathered.head.mode,
        generation: gathered.head.generation as number,
        keys: gathered.head.keys as Record<string, unknown>,
        reservedOpen: gathered.deliveries.length > 0,
      };
      if (ownerDate === null) return state;
      // One statement: the reserved items of this genesis on the date, and
      // whether the date's channel check is taken (by any genesis, as the
      // channel-check unique counts it).
      const [row] = await tx.$queryRaw<{ items: { key: string; kind: string; capped: boolean }[]; channelCheckTaken: boolean }[]>`
        SELECT coalesce((SELECT json_agg(json_build_object('key', i.signal || '#' || i.scope, 'kind', i.kind, 'capped', i.capped)
                                ORDER BY i.signal, i.scope, i.kind)
                           FROM "OpsObserverDeliveryItem" i
                           JOIN "OpsObserverDelivery" d ON d.id = i."deliveryId"
                          WHERE d."genesisId" = ${state.genesisId}::uuid AND d."ownerDate" = ${ownerDate}::date), '[]'::json) AS items,
               EXISTS (SELECT 1 FROM "OpsObserverDelivery" WHERE "channelCheckDate" = ${ownerDate}::date) AS "channelCheckTaken"`;
      return { ...state, budget: { ownerDate, reservedToday: row.items, channelCheckTaken: row.channelCheckTaken } };
    },
    client,
  );
  await assertNotLate(runDeadline, client);
  return result;
}

/** One message of an owner date as the daily digest reports it. */
export type OpsObserverDateItem = {
  key: string;
  kind: string;
  capped: boolean;
  mode: string;
  /** "reserved" (a reservation) or "deferred" (the daily cap held it back, §5). */
  status: string;
};

/**
 * Every message of one owner date -- reserved or held back by the cap, in
 * either mode, whichever genesis made it -- what the daily digest reports
 * (policy §1 item 3). The run budget above is per genesis (§5), but a digest
 * kept under the date's key must not lose what came before a recovery or an
 * activation that day, nor a shadow day's list because the head is live by
 * the time the digest runs. Each item names its own mode, so a live digest
 * never presents a shadow reservation as sent. Reserved first.
 */
export async function readOpsObserverDateItems(
  ownerDate: string,
  runDeadline: Date,
  client: PrismaClient = prisma,
): Promise<OpsObserverDateItem[]> {
  const { result } = await withOpsObserverTransaction(
    "state_read",
    runDeadline,
    async (tx) => {
      const [row] = await tx.$queryRaw<{ items: OpsObserverDateItem[] }[]>`
        SELECT coalesce(json_agg(json_build_object('key', x.signal || '#' || x.scope, 'kind', x.kind,
                                                   'capped', x.capped, 'mode', x.mode, 'status', x.status)
                                 ORDER BY x.status DESC, x.mode DESC, x.signal, x.scope, x.kind, x."openedAt"), '[]'::json) AS items
          FROM (SELECT i.signal, i.scope, i.kind, i.capped, i.mode, 'reserved' AS status, i."openedAt"
                  FROM "OpsObserverDeliveryItem" i
                  JOIN "OpsObserverDelivery" d ON d.id = i."deliveryId"
                 WHERE d."ownerDate" = ${ownerDate}::date
                UNION ALL
                SELECT f.signal, f.scope, f.kind, true AS capped, f.mode, 'deferred' AS status, f."openedAt"
                  FROM "OpsObserverDeferredItem" f
                 WHERE f."ownerDate" = ${ownerDate}::date) x`;
      return row.items;
    },
    client,
  );
  await assertNotLate(runDeadline, client);
  return result;
}

/** What the Admin genesis screen shows, and what an approval there binds. */
export type OpsObserverAdminView = {
  head: { genesisId: string; generation: number | null; mode: string; createdAt: string } | null;
  trustReason: string;
  /** When a genesis may next replace this head (the seven-day rule); null with no head. */
  nextGenesisAt: string | null;
  /** Whether the seven-day rule allows a genesis at the time of this read. */
  genesisAllowedNow: boolean;
};

/**
 * The owner's view of the chain (docs/policy/sre-ops.md §8): the head, with
 * or without its state row, and the trust verdict -- exactly the values a
 * genesis request must name back. Unlike the services' read it reports the
 * head of an untrusted chain, because that is what a recovery replaces; it
 * carries no keys. One bounded `state_read` transaction, and the deadline is
 * checked again before the view is returned, so a late read shows nothing
 * rather than a head the owner would then bind.
 */
export async function readOpsObserverAdminView(client: PrismaClient = prisma): Promise<OpsObserverAdminView> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  const runDeadline = new Date(Date.now() + GENESIS_REQUEST_DEADLINE_MS);
  const { result } = await withOpsObserverTransaction(
    "state_read",
    runDeadline,
    async (tx): Promise<OpsObserverAdminView> => {
      const gathered = await gatherFacts(tx, integrityKeys);
      const verdict = judgeTrust(gathered.facts) as { trusted: boolean; reason?: string };
      const head = gathered.chainHead;
      return {
        head: head
          ? {
              genesisId: head.id,
              generation: (head.generation as number | null) ?? null,
              mode: head.mode,
              createdAt: head.createdAt.toISOString(),
            }
          : null,
        trustReason: verdict.trusted ? "trusted" : (verdict.reason ?? "state_missing"),
        nextGenesisAt: head ? new Date(head.createdAt.getTime() + GENESIS_MIN_INTERVAL_MS).toISOString() : null,
        genesisAllowedNow: !head || Date.now() - head.createdAt.getTime() >= GENESIS_MIN_INTERVAL_MS,
      };
    },
    client,
  );
  // Like the services' read (policy §6): a late read is not returned as the
  // head and verdict the owner will bind.
  await assertNotLate(runDeadline, client);
  return result;
}

/** After an abandon, the heartbeat is held this long (dead-man allowance 30 min + one period 10 min, policy §3 rule 9). */
export const HEARTBEAT_WITHHOLD_MINUTES = 40;

export type OpsObserverAdvanceInput = {
  runDeadline: Date;
  runId: string;
  baseGenesisId: string;
  baseGeneration: number;
  /** The run's owner date: what the move owes is derived for it, reserved or not. */
  ownerDate: string;
  keys: Record<string, unknown>;
  reservation: OpsObserverReservationInput | null;
};

/** A reservation as parseAdvanceRequest() returns it. */
export type OpsObserverReservationInput = {
  ownerDate: string;
  channelCheck: boolean;
  items: { signal: string; scope: string; kind: string; origin: string; openedAt: Date }[];
};

export type OpsObserverAdvanceResult =
  | {
      result: "advanced";
      sendPermitted: boolean;
      deliveryId: string | null;
      heartbeatWithheld: boolean;
      generation: number;
    }
  | { result: "noop"; sendPermitted: false; heartbeatWithheld: boolean; generation: number }
  | {
      result: "conflict" | "replayed" | "rejected" | "reservation_not_owed" | "channel_check_taken";
      sendPermitted: false;
    }
  | { result: "untrusted"; trust: string; sendPermitted: false };

/** Key order does not change a key state; compare the value, not the bytes. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

async function heartbeatWithheld(tx: OpsObserverClient): Promise<boolean> {
  // Any genesis: an abandon under an earlier genesis still means a page may
  // have gone unsent, and the dead-man monitor must get its chance to say so.
  const rows = await tx.$queryRaw<{ withheld: boolean }[]>`
    SELECT coalesce(max("abandonedAt") + make_interval(mins => ${HEARTBEAT_WITHHOLD_MINUTES}) > clock_timestamp(), false)
           AS withheld
      FROM "OpsObserverDelivery"`;
  return rows[0]?.withheld !== false;
}

/**
 * Advances the state one generation in one `advance` transaction: the trust
 * check again, the base genesis and generation compared (a stale base is a
 * conflict and writes nothing), any open reservation closed as abandoned, the
 * keys written with the checkpoint moved to the previous generation, the
 * state_advanced audit entry as the ops-observer actor, and its ledger row --
 * all committing together or not at all. Unchanged keys with nothing to close
 * write nothing (noop) (docs/policy/sre-ops.md §3 rules 3, 7, 9 and 10).
 *
 * A reservation is inserted in the same transaction, and only then is sending
 * permitted (§3 rule 3). Every refusal is decided before the first write: the
 * items must be messages the key move actually owes (owedMessages), the same
 * run must not have reserved already (replayed), the day's channel check must
 * be free, and the daily cap is counted over this genesis's reservations for
 * the run's owner date (§5). The store derives everything the move owes and
 * splits it by the cap itself: the reservation must carry exactly what the cap
 * admits -- an item it holds back rejects the whole advance, and leaving out
 * one it admits is not owed -- and what it holds back is written, in the same
 * transaction, as a deferred item the daily digest reports. Whether an item is
 * capped is derived here, never taken from the request.
 *
 * Success is reported only after a separate short transaction confirms the
 * run is not past its deadline (policy §6 item 5).
 */
export async function advanceOpsObserverState(
  input: OpsObserverAdvanceInput,
  client: PrismaClient = prisma,
): Promise<OpsObserverAdvanceResult> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  const { result } = await withOpsObserverTransaction(
    "advance",
    input.runDeadline,
    async (tx): Promise<OpsObserverAdvanceResult> => {
      const gathered = await gatherFacts(tx, integrityKeys);
      const verdict = judgeTrust(gathered.facts) as { trusted: boolean; reason?: string };
      const head = gathered.head;
      if (!verdict.trusted || !head) {
        return { result: "untrusted", trust: verdict.reason ?? "state_missing", sendPermitted: false };
      }
      const previousGeneration = head.generation as number;
      if (head.id !== input.baseGenesisId || previousGeneration !== input.baseGeneration) {
        return { result: "conflict", sendPermitted: false };
      }
      if (!keysAreValid(input.keys)) return { result: "conflict", sendPermitted: false };

      // Decided from what was read, before anything is locked or written. What
      // the move owes for the run's owner date is derived here, never claimed:
      // owedMessages() in the order the run's own split used.
      const reservation = input.reservation;
      const owed = (
        owedMessages(head.keys, input.keys, input.ownerDate) as {
          signal: string; scope: string; kind: string; openedAt: number;
        }[]
      ).map((item) => ({ ...item, key: `${item.signal}#${item.scope}` }));
      if (reservation && !reservationIsOwed(reservation.items, owed)) {
        return { result: "reservation_not_owed", sendPermitted: false };
      }
      // The checkpoint moves to the generation before this one, whose ledger
      // row the trust check just verified; at generation 0 the genesis
      // approval stays the checkpoint.
      const anchor = gathered.ledgerRows.find((row) => row.generation === previousGeneration) ?? null;
      if (previousGeneration > 0 && !anchor) return { result: "untrusted", trust: "checkpoint_broken", sendPermitted: false };
      const checkpoint = previousGeneration;

      // Take the base before writing anything. Under READ COMMITTED another
      // advance may have committed since the facts were read; the lock waits
      // for it, re-reads the row, and finds no row at the base. Then nothing
      // has been written and the conflict is the whole answer.
      const locked = await tx.$queryRaw<{ generation: number }[]>`
        SELECT generation FROM "OpsObserverState"
         WHERE "genesisId" = ${head.id}::uuid AND generation = ${previousGeneration}
         FOR UPDATE`;
      if (locked.length === 0) return { result: "conflict", sendPermitted: false };

      // With the base held no other advance can reserve, so these reads stay
      // true until commit.
      if (reservation) {
        const [taken] = await tx.$queryRaw<{ replayed: boolean; channelCheckTaken: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM "OpsObserverDelivery" WHERE "runId" = ${input.runId}) AS replayed,
                 EXISTS (SELECT 1 FROM "OpsObserverDelivery" WHERE "channelCheckDate" = ${reservation.ownerDate}::date)
                   AS "channelCheckTaken"`;
        if (taken.replayed) return { result: "replayed", sendPermitted: false };
        if (reservation.channelCheck && taken.channelCheckTaken) {
          return { result: "channel_check_taken", sendPermitted: false };
        }
      }
      // The cap splits everything owed (§5), counted over this genesis's
      // reservations for the date. The reservation must carry exactly what it
      // admits: an item it holds back is refused, and one it admits may not be
      // left out. What it holds back is recorded below rather than lost.
      type Split = { key: string; kind: string; capped: boolean; signal: string; scope: string; openedAt: number };
      let admitted: Split[] = [];
      let deferred: Split[] = [];
      if (owed.length > 0) {
        const reservedToday = await tx.$queryRaw<{ key: string; kind: string; capped: boolean }[]>`
          SELECT i.signal || '#' || i.scope AS key, i.kind, i.capped
            FROM "OpsObserverDeliveryItem" i
            JOIN "OpsObserverDelivery" d ON d.id = i."deliveryId"
           WHERE d."genesisId" = ${head.id}::uuid AND d."ownerDate" = ${input.ownerDate}::date`;
        ({ admitted, deferred } = admitOwedItems({ reservedToday, owed }) as { admitted: Split[]; deferred: Split[] });
      }
      const itemId = (item: { key: string; kind: string }) => `${item.key}:${item.kind}`;
      const reservedIds = (reservation?.items ?? []).map((item) => itemId({ key: `${item.signal}#${item.scope}`, kind: item.kind }));
      if (reservedIds.some((id) => deferred.some((item) => itemId(item) === id))) {
        return { result: "rejected", sendPermitted: false };
      }
      if (stableJson([...reservedIds].sort()) !== stableJson(admitted.map(itemId).sort())) {
        return { result: "reservation_not_owed", sendPermitted: false };
      }
      const cappedById = new Map(admitted.map((item) => [itemId(item), item.capped]));

      // Every reservation still open is closed, whichever genesis made it: one
      // left by a genesis since replaced is just as unknown, and the marker that
      // allows one open reservation spans the table.
      const abandoned = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "OpsObserverDelivery"
           SET status = 'abandoned', "stampStatus" = 'abandoned', "runDeadlineAt" = ${input.runDeadline.toISOString()}::timestamptz
         WHERE status = 'reserved'
        RETURNING id`;
      if (!reservation && abandoned.length === 0 && stableJson(input.keys) === stableJson(head.keys)) {
        return {
          result: "noop",
          sendPermitted: false,
          heartbeatWithheld: await heartbeatWithheld(tx),
          generation: previousGeneration,
        };
      }

      const [updated] = await tx.$queryRaw<{ generation: number; stampKeysSha256: string }[]>`
        UPDATE "OpsObserverState"
           SET generation = generation + 1, keys = ${JSON.stringify(input.keys)}::jsonb,
               "verifiedThroughGeneration" = ${checkpoint},
               "verifiedThroughAuditId" = ${anchor?.auditLogId ?? null},
               "verifiedThroughAuditHash" = ${anchor?.auditEntryHash ?? null},
               "runDeadlineAt" = ${input.runDeadline.toISOString()}::timestamptz
         WHERE "genesisId" = ${head.id}::uuid AND generation = ${previousGeneration}
        RETURNING generation, "stampKeysSha256"`;
      // The row is locked at the base, so this cannot miss; if it does, roll
      // back the abandon with it rather than report a conflict over a write.
      if (!updated) throw new Error("ops_observer_state_update_missed_locked_row");

      // The reservation and its items: the guard copies the genesis mode, marks
      // it the one open reservation and stamps it; the item guard requires this
      // transaction's still-reserved delivery.
      let deliveryId: string | null = null;
      if (reservation) {
        deliveryId = crypto.randomUUID();
        await tx.$executeRaw`
          INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "channelCheckDate",
            "digestItemId", "invariantVersion", "stampStatus", "runDeadlineAt")
          VALUES (${deliveryId}::uuid, ${head.id}::uuid, ${head.mode}, ${input.runId}, 'reserved',
            ${reservation.ownerDate}::date, ${reservation.channelCheck ? reservation.ownerDate : null}::date,
            NULL, 0, 'reserved', ${input.runDeadline.toISOString()}::timestamptz)`;
        if (reservation.items.length > 0) {
          const items = reservation.items.map((item) => ({
            ...item,
            capped: cappedById.get(itemId({ key: `${item.signal}#${item.scope}`, kind: item.kind })) === true,
          }));
          await tx.$executeRaw`
            INSERT INTO "OpsObserverDeliveryItem" (id, "deliveryId", mode, signal, scope, kind, origin, "openedAt", capped)
            SELECT gen_random_uuid(), ${deliveryId}::uuid, ${head.mode}, x.signal, x.scope, x.kind, x.origin, x.opened, x.capped
              FROM unnest(${items.map((i) => i.signal)}::text[], ${items.map((i) => i.scope)}::text[],
                          ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.origin)}::text[],
                          ${items.map((i) => i.openedAt.toISOString())}::timestamptz[],
                          ${items.map((i) => i.capped)}::boolean[])
                AS x(signal, scope, kind, origin, opened, capped)`;
        }
      }
      // What the cap held back, so the digest still reports it (§1 item 3).
      // The guard copies the genesis mode; origin is read from the key's open
      // state the way the run reads it.
      if (deferred.length > 0) {
        const origins = deferred.map((item) =>
          incidentOrigin(item.kind === "recovery" ? head.keys[item.key] : input.keys[item.key]),
        );
        await tx.$executeRaw`
          INSERT INTO "OpsObserverDeferredItem" (id, "genesisId", mode, "ownerDate", signal, scope, kind, origin, "openedAt",
            "invariantVersion", "runDeadlineAt")
          SELECT gen_random_uuid(), ${head.id}::uuid, ${head.mode}, ${input.ownerDate}::date, x.signal, x.scope, x.kind,
                 x.origin, x.opened, 0, ${input.runDeadline.toISOString()}::timestamptz
            FROM unnest(${deferred.map((i) => i.signal)}::text[], ${deferred.map((i) => i.scope)}::text[],
                        ${deferred.map((i) => i.kind)}::text[], ${origins}::text[],
                        ${deferred.map((i) => new Date(i.openedAt).toISOString())}::timestamptz[])
              AS x(signal, scope, kind, origin, opened)`;
      }

      const entry = await tx.$appendSystemAudit({
        action: "ops_observer.state_advanced",
        targetType: "OpsObserverState",
        targetId: head.id,
        summary: "Advanced the ops-observer state.",
        metadata: {
          generation: updated.generation,
          keysSha256: updated.stampKeysSha256,
          abandonedDeliveryIds: abandoned.map((row) => row.id),
          reservedDeliveryId: deliveryId,
          digestItemId: null,
          verifiedThroughGeneration: checkpoint,
          verifiedThroughAuditHash: anchor?.auditEntryHash ?? null,
          runDeadlineAt: input.runDeadline.toISOString(),
          runId: input.runId,
        },
      });
      // T0 already refused a missing key, so an unsigned entry is a defect.
      if (!entry.entryHash) throw new Error("ops_observer_audit_unsigned");
      await tx.$executeRaw`
        INSERT INTO "OpsObserverTransition" ("genesisId", generation, "auditLogId", "auditEntryHash", "keysSha256", "runDeadlineAt")
        VALUES (${head.id}::uuid, ${updated.generation}, ${entry.id}, ${entry.entryHash}, ${updated.stampKeysSha256}, ${input.runDeadline.toISOString()}::timestamptz)`;
      return {
        result: "advanced",
        // Only the request whose transaction inserted the reservation may send.
        sendPermitted: deliveryId !== null,
        deliveryId,
        heartbeatWithheld: await heartbeatWithheld(tx),
        generation: updated.generation,
      };
    },
    client,
  );
  if (result.result === "advanced" || result.result === "noop") await assertNotLate(input.runDeadline, client);
  return result;
}

export type OpsObserverConfirmInput = { runDeadline: Date; deliveryId: string; runId: string };

export type OpsObserverConfirmResult =
  | { result: "confirmed" | "shadowed" | "replayed" }
  | { result: "not_found" | "abandoned" }
  | { result: "untrusted"; trust: string };

/**
 * Closes the run's reservation after its send (docs/policy/sre-ops.md §3 rules
 * 3 and 9, §6). One `confirm` transaction: the trust check again, the
 * reservation locked by its id and the run that made it, and the close --
 * `confirmed` under a live genesis, `shadowed` under a shadow one, decided by
 * the row's mode and never by the request -- with its system audit entry.
 * A reservation already closed by its own confirm answers `replayed`; one the
 * next advance closed as abandoned stays abandoned and is refused.
 */
export async function confirmOpsObserverDelivery(
  input: OpsObserverConfirmInput,
  client: PrismaClient = prisma,
): Promise<OpsObserverConfirmResult> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  const { result } = await withOpsObserverTransaction(
    "confirm",
    input.runDeadline,
    async (tx): Promise<OpsObserverConfirmResult> => {
      const gathered = await gatherFacts(tx, integrityKeys);
      const verdict = judgeTrust(gathered.facts) as { trusted: boolean; reason?: string };
      if (!verdict.trusted) return { result: "untrusted", trust: verdict.reason ?? "state_missing" };

      // The row and the mode of the genesis that made it. The trust check reads
      // only the current genesis's open reservation; this one may be older, so
      // its own stamps are checked here before it is touched -- the close would
      // otherwise overwrite them with the trigger's.
      const [row] = await tx.$queryRaw<
        { genesisId: string; mode: string; status: string; invariantVersion: number; stampStatus: string; genesisMode: string }[]
      >`
        SELECT d."genesisId", d.mode, d.status, d."invariantVersion", d."stampStatus", g.mode AS "genesisMode"
          FROM "OpsObserverDelivery" d
          JOIN "OpsObserverGenesis" g ON g.id = d."genesisId"
         WHERE d.id = ${input.deliveryId}::uuid AND d."runId" = ${input.runId}
         FOR UPDATE OF d`;
      if (!row) return { result: "not_found" };
      const stamp = deliveryStampReason([row], row.genesisMode) as string | null;
      if (stamp) return { result: "untrusted", trust: stamp };
      if (row.status === "confirmed" || row.status === "shadowed") return { result: "replayed" };
      if (row.status !== "reserved") return { result: "abandoned" };

      const closed = confirmStatusForMode(row.mode) as "confirmed" | "shadowed";
      await tx.$executeRaw`
        UPDATE "OpsObserverDelivery"
           SET status = ${closed}, "stampStatus" = ${closed}, "runDeadlineAt" = ${input.runDeadline.toISOString()}::timestamptz
         WHERE id = ${input.deliveryId}::uuid AND status = 'reserved'`;
      await tx.$appendSystemAudit({
        action: closed === "confirmed" ? "ops_observer.delivery_confirmed" : "ops_observer.delivery_shadowed",
        targetType: "OpsObserverDelivery",
        targetId: input.deliveryId,
        summary: closed === "confirmed" ? "Confirmed an ops-observer page." : "Closed a shadow ops-observer reservation.",
        metadata: { genesisId: row.genesisId, runId: input.runId, runDeadlineAt: input.runDeadline.toISOString() },
      });
      return { result: closed };
    },
    client,
  );
  if (result.result === "confirmed" || result.result === "shadowed") await assertNotLate(input.runDeadline, client);
  return result;
}

/** How far ahead an Admin genesis request sets its own deadline (within the 180 s claim limit). */
export const GENESIS_REQUEST_DEADLINE_MS = 120_000;

export type OpsObserverGenesisInput = {
  session: Session;
  request?: Request;
  reason: "initial" | "recovery" | "activation";
  mode: "shadow" | "live";
  /** The state the owner looked at when approving: the screen binds these. */
  expectedGenesisId: string | null;
  expectedGeneration: number | null;
  expectedMode: string | null;
  trustReason: string;
};

export type OpsObserverGenesisResult =
  | { result: "created"; genesisId: string; requestDigest: string }
  | { result: "stale" | "genesis_too_soon" | "transition_refused" | "already_consumed" };

/** The approval binds this exact JSON, keys sorted, hashed with SHA-256. */
export function genesisRequestDigest(input: Omit<OpsObserverGenesisInput, "session" | "request">): string {
  return createHash("sha256")
    .update(
      stableJson({
        agentKey: "sre-ops",
        expectedGenesisId: input.expectedGenesisId,
        expectedGeneration: input.expectedGeneration,
        expectedMode: input.expectedMode,
        trustReason: input.trustReason,
        reason: input.reason,
        mode: input.mode,
      }),
      "utf8",
    )
    .digest("hex");
}

/** The PostgreSQL SQLSTATE an error carries, by code only. */
function sqlState(error: unknown): string | null {
  const e = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  for (const candidate of [cause?.originalCode, cause?.code, e?.code]) {
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  }
  return null;
}

type OpsObserverAdminAuditInput = Omit<Parameters<typeof writeAdminAuditLog>[0], "tx">;
type OpsObserverAdminClient = OpsObserverClient & {
  $appendAdminAudit(input: OpsObserverAdminAuditInput): Promise<string>;
};

/** The owner's audit entry, charged the four statements of an append. */
const ADMIN_HELPERS = Object.freeze({
  $appendAdminAudit: {
    cost: AUDIT_APPEND_STATEMENT_COST,
    run: (tx: Prisma.TransactionClient, input: OpsObserverAdminAuditInput) => writeAdminAuditLog({ ...input, tx }),
  },
});

/**
 * The Admin genesis (docs/policy/sre-ops.md §8, decisions D5b and N-6): the
 * owner's approval to start, recover or activate the agent's state chain.
 *
 * One `genesis` transaction. The current head and trust verdict are read
 * again and must be exactly what the owner approved (else `stale`, nothing
 * written); the reason must fit the chain (`initial` with no genesis,
 * `recovery` of an untrusted chain in its own mode, `activation` of a trusted
 * shadow chain to live); a head younger than seven days refuses
 * (`genesis_too_soon`). Then the genesis row, the owner's audit entry naming
 * the request digest, predecessor and mode -- what the trust check's T1 reads
 * -- and the generation-0 state row, last. A concurrent approval of the same
 * head loses on the database's unique replacement (`already_consumed`).
 */
export async function createOpsObserverGenesis(
  input: OpsObserverGenesisInput,
  client: PrismaClient = prisma,
): Promise<OpsObserverGenesisResult> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  const runDeadline = new Date(Date.now() + GENESIS_REQUEST_DEADLINE_MS);
  const requestDigest = genesisRequestDigest(input);
  let result: OpsObserverGenesisResult;
  try {
    ({ result } = await withOpsObserverTransaction(
      "genesis",
      runDeadline,
      async (tx): Promise<OpsObserverGenesisResult> => {
        // Serialize with the advance before anything is judged: it takes the
        // same row lock on the head's state, so an advance committed while
        // this waited is read below and the approval of the generation before
        // it is stale -- never a replacement of state the owner did not see.
        await tx.$queryRaw`
          SELECT s."genesisId" FROM "OpsObserverState" s
            JOIN "OpsObserverGenesis" g ON g.id = s."genesisId"
           WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" x WHERE x."supersedesGenesisId" = g.id)
             FOR UPDATE OF s`;
        const gathered = await gatherFacts(tx, integrityKeys);
        const verdict = judgeTrust(gathered.facts) as { trusted: boolean; reason?: string };
        const trust = verdict.trusted ? "trusted" : (verdict.reason ?? "state_missing");
        // The chain head, with or without its state row: a head whose state is
        // missing is what a recovery replaces.
        const head = gathered.chainHead;
        const current = {
          genesisId: head?.id ?? null,
          generation: (head?.generation as number | null) ?? null,
          mode: head?.mode ?? null,
        };
        if (
          current.genesisId !== input.expectedGenesisId ||
          current.generation !== input.expectedGeneration ||
          current.mode !== input.expectedMode ||
          trust !== input.trustReason
        ) {
          return { result: "stale" };
        }
        const supersedesGenesisId = head?.id ?? null;
        const refusal = genesisRefusal(
          { reason: input.reason, mode: input.mode, supersedesGenesisId },
          head ? { id: head.id, mode: head.mode } : null,
        );
        if (refusal) return { result: "transition_refused" };
        if (input.reason === "activation" && trust !== "trusted") return { result: "transition_refused" };
        if (input.reason === "recovery" && trust === "trusted") return { result: "transition_refused" };
        if (head && Date.now() - head.createdAt.getTime() < GENESIS_MIN_INTERVAL_MS) return { result: "genesis_too_soon" };

        const genesisId = crypto.randomUUID();
        await tx.$executeRaw`
          INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
          VALUES (${genesisId}::uuid, ${input.reason}, ${input.mode}, ${supersedesGenesisId}::uuid, ${requestDigest}, ${OPS_OBSERVER_INVARIANT_VERSION},
                  ${runDeadline.toISOString()}::timestamptz)`;
        await (tx as OpsObserverAdminClient).$appendAdminAudit({
          session: input.session,
          request: input.request,
          action: "ops_observer.genesis_created",
          targetType: "OpsObserverGenesis",
          targetId: genesisId,
          summary: `Approved an ops-observer ${input.reason} genesis (${input.mode}).`,
          metadata: {
            requestDigest,
            supersedesGenesisId,
            mode: input.mode,
            reason: input.reason,
            expectedGenesisId: input.expectedGenesisId,
            expectedGeneration: input.expectedGeneration,
            expectedMode: input.expectedMode,
            trustReason: input.trustReason,
          },
        });
        const keys = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
        await tx.$executeRaw`
          INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
            "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
          VALUES (${genesisId}::uuid, 0, ${JSON.stringify(keys)}::jsonb, 0, 0, '', '', ${runDeadline.toISOString()}::timestamptz)`;
        return { result: "created", genesisId, requestDigest };
      },
      client,
      ADMIN_HELPERS,
    ));
  } catch (error) {
    const state = sqlState(error);
    // A concurrent approval of the same head took the replacement first.
    if (state === "23505") return { result: "already_consumed" };
    // The head moved under the request: what the owner approved is gone.
    if (state === "OB022" || state === "OB021") return { result: "stale" };
    throw error;
  }
  if (result.result === "created") await assertNotLate(runDeadline, client);
  return result;
}

/** The most reservations one retention batch deletes. */
export const DELIVERY_RETENTION_BATCH_LIMIT = 500;

/** How far ahead a retention batch sets its own deadline (inside its 30 s Prisma timeout). */
const RETENTION_DEADLINE_MS = 25_000;

/**
 * One retention batch for the reservations (docs/policy/sre-ops.md §10): up
 * to `limit` closed reservations whose close is at least
 * DELIVERY_RETENTION_DAYS old, oldest first, with their items (the foreign
 * key cascades). A `reserved` row is never selected and the delete trigger
 * refuses one anyway, as it refuses anything closed more recently. Rows
 * another transaction holds are skipped, not waited on. A batch that deleted
 * anything leaves one system audit entry with the count, in the same
 * transaction; an empty batch writes nothing. The batch names its deadline in
 * the transaction-local setting the retention trigger reads at COMMIT, so a
 * late batch rolls back whole, deletes included.
 */
export async function purgeOpsObserverDeliveries(
  limit: number = DELIVERY_RETENTION_BATCH_LIMIT,
  client: PrismaClient = prisma,
): Promise<{ deleted: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DELIVERY_RETENTION_BATCH_LIMIT) {
    throw new Error("ops_observer_retention_limit_invalid");
  }
  const runDeadline = new Date(Date.now() + RETENTION_DEADLINE_MS);
  const { result } = await withOpsObserverTransaction(
    "retention_batch",
    runDeadline,
    async (tx) => {
      // The deferred retention trigger checks this at COMMIT (policy §6 item
      // 5): a delete has no row deadline, so the batch names its own, and a
      // batch past it does not commit.
      await tx.$queryRaw`
        SELECT set_config('ops_observer.retention_deadline', ${runDeadline.toISOString()}, true)`;
      const deleted = await tx.$queryRaw<{ id: string }[]>`
        DELETE FROM "OpsObserverDelivery"
         WHERE id IN (
           SELECT id FROM "OpsObserverDelivery"
            WHERE status <> 'reserved'
              AND coalesce("confirmedAt", "shadowedAt", "abandonedAt")
                  <= clock_timestamp() - make_interval(days => ${DELIVERY_RETENTION_DAYS})
            ORDER BY coalesce("confirmedAt", "shadowedAt", "abandonedAt"), id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      // What the daily cap held back keeps the same retention, from when it
      // was written, under the same named deadline and the same audit entry.
      const deferred = await tx.$queryRaw<{ id: string }[]>`
        DELETE FROM "OpsObserverDeferredItem"
         WHERE id IN (
           SELECT id FROM "OpsObserverDeferredItem"
            WHERE "deferredAt" <= clock_timestamp() - make_interval(days => ${DELIVERY_RETENTION_DAYS})
            ORDER BY "deferredAt", id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      if (deleted.length > 0 || deferred.length > 0) {
        await tx.$appendSystemAudit({
          action: "ops_observer.deliveries_purged",
          targetType: "OpsObserverDelivery",
          targetId: null,
          summary: "Deleted closed ops-observer reservations past their retention.",
          metadata: { count: deleted.length, deferredCount: deferred.length, retentionDays: DELIVERY_RETENTION_DAYS },
        });
      }
      return { deleted: deleted.length + deferred.length };
    },
    client,
  );
  await assertNotLate(runDeadline, client);
  return result;
}

/** One reservation as the Admin item screen shows it: the page link's target. */
export type OpsObserverDeliveryView = {
  id: string;
  genesisId: string;
  mode: string;
  status: string;
  ownerDate: string;
  channelCheck: boolean;
  reservedAt: string;
  closedAt: string | null;
  items: { signal: string; scope: string; kind: string; origin: string; openedAt: string; capped: boolean }[];
};

/**
 * The reservation a page message links to (docs/policy/sre-ops.md §3 rule 1,
 * §4): the link carries only its server-minted id, and this is what the owner
 * sees behind it -- the keys, message kinds and times the message itself may
 * not carry. Read-only; `null` for an id that is not (or no longer, after the
 * ninety days of §10) a reservation. One bounded `state_read` transaction,
 * and the deadline is checked again before anything is returned.
 */
export async function readOpsObserverDelivery(
  deliveryId: string,
  client: PrismaClient = prisma,
  runDeadline: Date = new Date(Date.now() + GENESIS_REQUEST_DEADLINE_MS),
): Promise<OpsObserverDeliveryView | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deliveryId)) return null;
  const { result } = await withOpsObserverTransaction(
    "state_read",
    runDeadline,
    async (tx): Promise<OpsObserverDeliveryView | null> => {
      const [row] = await tx.$queryRaw<
        {
          id: string;
          genesisId: string;
          mode: string;
          status: string;
          ownerDate: string;
          channelCheck: boolean;
          reservedAt: Date;
          closedAt: Date | null;
          items: OpsObserverDeliveryView["items"] | null;
        }[]
      >`
        SELECT d.id::text AS id, d."genesisId"::text AS "genesisId", d.mode, d.status,
               to_char(d."ownerDate", 'YYYY-MM-DD') AS "ownerDate",
               d."channelCheckDate" IS NOT NULL AS "channelCheck",
               d."reservedAt", coalesce(d."confirmedAt", d."shadowedAt", d."abandonedAt") AS "closedAt",
               (SELECT json_agg(json_build_object('signal', i.signal, 'scope', i.scope, 'kind', i.kind,
                         'origin', i.origin,
                         'openedAt', to_char(i."openedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                         'capped', i.capped)
                       ORDER BY i.signal, i.scope)
                  FROM "OpsObserverDeliveryItem" i WHERE i."deliveryId" = d.id) AS items
          FROM "OpsObserverDelivery" d
         WHERE d.id = ${deliveryId}::uuid
           -- Past its retention (policy §10) it is absent, by the purge's own
           -- condition, even before a retention batch has removed it.
           AND NOT (d.status <> 'reserved'
                    AND coalesce(d."confirmedAt", d."shadowedAt", d."abandonedAt")
                        <= clock_timestamp() - make_interval(days => ${DELIVERY_RETENTION_DAYS}))`;
      if (!row) return null;
      return {
        id: row.id,
        genesisId: row.genesisId,
        mode: row.mode,
        status: row.status,
        ownerDate: row.ownerDate,
        channelCheck: row.channelCheck,
        reservedAt: row.reservedAt.toISOString(),
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
        items: row.items ?? [],
      };
    },
    client,
  );
  // Like every other read (policy §6 item 5): a late read shows nothing.
  await assertNotLate(runDeadline, client);
  return result;
}
