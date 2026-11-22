import "server-only";

import type { Prisma } from "@prisma/client";

import { amuxFeatureDisplayPrefixChoices } from "@/lib/amux/cardDisplayKeyBackfillCore";
import {
  formatAmuxCardDisplayKey,
  isAmuxCardDisplayPrefix,
  pickAmuxFeatureDisplayPrefix,
} from "@/lib/amux/cardDisplayKeyCore";

type AllocatorClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Takes the next number of `prefix` inside the caller's transaction and
 * returns its display key (docs/policy/amux-card-display-key.md §3).
 *
 * One statement: the first card of a prefix inserts its counter at 1, every
 * later one increments it, and RETURNING hands back the number this
 * transaction now holds. The counter row stays locked until the caller
 * commits, so a concurrent allocation of the same prefix waits and then reads
 * the committed value; under READ COMMITTED that is the next number, never the
 * same one. If the caller rolls back, the increment rolls back with it and no
 * number is spent. The caller writes the key to its card in the same
 * transaction; the unique index on `AmuxWorkItem.displayKey` refuses a reuse
 * even if the counter were ever wrong.
 *
 * The same statement takes the audit chain's lock before it touches the
 * counter row. Every caller writes an audit entry after allocating, and the
 * backfill writes its entry before allocating; `lib/adminAudit.ts` orders that
 * lock before any row lock. Taking the counter row first would let a
 * registration and the backfill each hold what the other waits for. The lock
 * is the one `takeAuditChainLock()` takes, re-entrant and held to commit, and
 * folding it in here keeps the allocation one statement for every bounded
 * caller.
 *
 * It only allocates. Which prefix a card uses (its Feature's, or its
 * registration path's) is the caller's decision.
 */
export async function allocateAmuxCardDisplayKey(tx: AllocatorClient, prefix: string): Promise<string> {
  if (!isAmuxCardDisplayPrefix(prefix)) {
    throw new Error("AMUX card display prefix is invalid");
  }
  const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
    WITH "auditChainLock" AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))
    )
    INSERT INTO "AmuxCardDisplayKeyCounter" ("prefix", "lastNumber")
    SELECT ${prefix}, 1 FROM "auditChainLock"
    ON CONFLICT ("prefix") DO UPDATE
      SET "lastNumber" = "AmuxCardDisplayKeyCounter"."lastNumber" + 1
    RETURNING "lastNumber"
  `;
  if (rows.length !== 1) {
    throw new Error("AMUX card display counter returned no number");
  }
  return formatAmuxCardDisplayKey(prefix, Number(rows[0].lastNumber));
}

/**
 * The prefix a new Feature takes (docs/policy/amux-intake.md v17 item 3 and
 * the 2026-11-22 owner decision): the proposal or its first free
 * `<PREFIX>2` .. `<PREFIX>99` variant; with no usable proposal, the prefix
 * its title suggests, then FEAT<n>, as the backfill chooses
 * (amuxFeatureDisplayPrefixChoices). When FEAT1..FEAT999 are all held too,
 * the next FEAT<n> after the highest one, so a Feature always gets one.
 * Reads inside the caller's transaction; the unique index on
 * `AmuxPortfolioNode.displayPrefix` still refuses a concurrent creation that
 * chose the same one.
 */
export async function chooseAmuxFeatureDisplayPrefix(
  tx: AllocatorClient, proposed: unknown, title: string | null = null,
): Promise<string | null> {
  const candidates = amuxFeatureDisplayPrefixChoices({ proposed, title });
  const taken = await tx.$queryRaw<Array<{ displayPrefix: string }>>`
    SELECT "displayPrefix" FROM "AmuxPortfolioNode"
    WHERE "displayPrefix" = ANY(${candidates}::TEXT[])
  `;
  const picked = pickAmuxFeatureDisplayPrefix(candidates, new Set(taken.map((row) => row.displayPrefix)));
  if (picked !== null) return picked;
  const highest = await tx.$queryRaw<Array<{ highest: bigint | number | null }>>`
    SELECT MAX(substring("displayPrefix" FROM 5)::BIGINT) AS "highest" FROM "AmuxPortfolioNode"
    WHERE "displayPrefix" ~ '^FEAT[0-9]{1,12}$'
  `;
  const next = `FEAT${BigInt(highest[0]?.highest ?? 0) + BigInt(1)}`;
  return isAmuxCardDisplayPrefix(next) ? next : null;
}

/**
 * Gives an existing Feature that has no prefix one now, so the card being
 * registered under it is numbered (owner decision 2026-11-22). Its title is
 * not readable here, so the choice is FEAT<n> unless a title is supplied.
 * NULL -> value is the one change the immutability trigger allows; a
 * concurrent writer that set it first wins and its prefix is returned.
 */
export async function assignAmuxFeatureDisplayPrefix(
  tx: AllocatorClient, featureNodeId: string, title: string | null = null,
): Promise<string | null> {
  const prefix = await chooseAmuxFeatureDisplayPrefix(tx, null, title);
  if (prefix !== null) {
    await tx.$queryRaw`
      UPDATE "AmuxPortfolioNode" SET "displayPrefix" = ${prefix}
      WHERE "id" = ${featureNodeId} AND "level" = 'feature' AND "displayPrefix" IS NULL
      RETURNING "id"
    `;
  }
  const rows = await tx.$queryRaw<Array<{ displayPrefix: string | null }>>`
    SELECT "displayPrefix" FROM "AmuxPortfolioNode" WHERE "id" = ${featureNodeId}
  `;
  return rows[0]?.displayPrefix ?? null;
}
