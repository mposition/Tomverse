import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildCollectionCandidateWhere, encodeCollectionQueueCursor,
  type AmuxV4CollectionQueueCursor } from "./ideaCollectionQueueCore.ts";

const PAGE_SIZE = 32;

/** Metadata-only, read-only polling. No scope, path, source body, prompt or
 * credential is selected; a later claim must revalidate every invariant. */
export async function listAmuxV4CollectionCandidates(
  cursor: AmuxV4CollectionQueueCursor | null,
): Promise<{
  candidates: Array<{ collectionRequestId: string; expiresAt: string }>;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  return prisma.$transaction(async (tx) =>
    listAmuxV4CollectionCandidatesInTransaction(tx, cursor),
  { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 2_000, timeout: 5_000 });
}

/** Synthetic DB tests use this reader inside their rollback transaction; the
 * production route always enters through listAmuxV4CollectionCandidates. */
export async function listAmuxV4CollectionCandidatesInTransaction(
  tx: Prisma.TransactionClient, cursor: AmuxV4CollectionQueueCursor | null,
) {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '3000', true) AS idle_limit
  `;
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("AMUX v4 collection queue clock unavailable");
  }
  const rows = await tx.amuxIdeaCollectionRequest.findMany({
    where: buildCollectionCandidateWhere(now, cursor),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: PAGE_SIZE + 1,
    select: { id: true, createdAt: true, expiresAt: true },
  });
  const candidates = rows.slice(0, PAGE_SIZE);
  const last = candidates.at(-1);
  return {
    candidates: candidates.map((row) => ({
      collectionRequestId: row.id, expiresAt: row.expiresAt.toISOString(),
    })),
    hasMore: rows.length > PAGE_SIZE,
    nextCursor: rows.length > PAGE_SIZE && last
      ? encodeCollectionQueueCursor({ createdAt: last.createdAt,
        collectionRequestId: last.id }) : null,
  };
}
