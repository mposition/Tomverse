import "server-only";

import type { Prisma } from "@prisma/client";

import {
  amuxFeatureDisplayPrefixCandidates,
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
 * It only allocates. Which prefix a card uses (its Feature's, or its
 * registration path's) is the caller's decision.
 */
export async function allocateAmuxCardDisplayKey(tx: AllocatorClient, prefix: string): Promise<string> {
  if (!isAmuxCardDisplayPrefix(prefix)) {
    throw new Error("AMUX card display prefix is invalid");
  }
  const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
    INSERT INTO "AmuxCardDisplayKeyCounter" ("prefix", "lastNumber")
    VALUES (${prefix}, 1)
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
 * The prefix a new Feature takes (docs/policy/amux-intake.md v17 item 3): the
 * proposal, or the first `<PREFIX>2` .. `<PREFIX>99` variant no Feature holds
 * yet; null when there is no valid proposal or every variant is taken. One
 * read, inside the caller's transaction; the unique index on
 * `AmuxPortfolioNode.displayPrefix` still refuses a concurrent creation that
 * chose the same one.
 */
export async function chooseAmuxFeatureDisplayPrefix(
  tx: AllocatorClient, proposed: unknown,
): Promise<string | null> {
  const candidates = amuxFeatureDisplayPrefixCandidates(proposed);
  if (candidates.length === 0) return null;
  const taken = await tx.$queryRaw<Array<{ displayPrefix: string }>>`
    SELECT "displayPrefix" FROM "AmuxPortfolioNode"
    WHERE "displayPrefix" = ANY(${candidates}::TEXT[])
  `;
  return pickAmuxFeatureDisplayPrefix(candidates, new Set(taken.map((row) => row.displayPrefix)));
}
