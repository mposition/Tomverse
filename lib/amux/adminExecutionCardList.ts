import "server-only";

import { prisma } from "@/lib/prisma";
import { listAmuxCardsForAdmin, type AmuxAdminCardRow } from "./adminCardList.ts";
import { readAmuxCardTitle } from "./adminExecutionRead.ts";

/**
 * The Execution board's List view: the owner card list (`listAmuxCardsForAdmin`,
 * the newest cards by last change) with what a person reads first on each row,
 * the card's title and the worker it was assigned to.
 *
 * Read only. The title is read the way the board reads it (a digest-verified
 * title, or null when it is unavailable or expired), never from free text a
 * worker wrote.
 */
export type AmuxExecutionListRow = AmuxAdminCardRow & {
  title: string | null;
  /** The worker the card was assigned to; null before an assignment. */
  worker: string | null;
};

export async function listAmuxCardsForExecutionList(): Promise<{
  rows: AmuxExecutionListRow[];
  total: number;
  limit: number;
}> {
  const base = await listAmuxCardsForAdmin();
  const ids = base.rows.map((row) => row.id);
  const details = ids.length === 0 ? [] : await prisma.amuxWorkItem.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, title: true, sourceSystem: true, sourceSnapshot: true,
      v4TitleCiphertext: true, v4TitleKeyId: true, v4TitleKeyVersion: true,
      v4TitleDigest: true, v4TitleDigestKeyId: true,
      v22AcceptedAssignment: { select: { workerName: true } },
    },
  });
  const titles = await Promise.all(details.map(readAmuxCardTitle));
  const byId = new Map(details.map((row, index) => [row.id, {
    title: titles[index], worker: row.v22AcceptedAssignment?.workerName ?? null,
  }]));
  return {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      title: byId.get(row.id)?.title ?? null,
      worker: byId.get(row.id)?.worker ?? null,
    })),
  };
}
