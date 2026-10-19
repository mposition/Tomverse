import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { dmAdminAttentionKind, type DmAdminAttentionKind } from "@/lib/amux/decisionMakerAdminCore";
import {
  listDecisionMakerRequestsForAdmin,
  readDecisionMakerRequestDetailForAdmin,
} from "@/lib/amux/decisionMakerAdminRead";

/** The attention lane shows at most this many requests and says how many more wait. */
export const DM_ATTENTION_SHOWN_LIMIT = 6;

/** One Decision Maker request waiting on a person, as the Execution board draws it. */
export type DmAttentionItem = {
  requestId: string;
  cardId: string;
  questionRevision: number;
  askingWorkerId: string;
  instance: string | null;
  kind: DmAdminAttentionKind;
  irreversible: boolean | null;
  createdAtMs: number;
  /** The worker's question and the proposal, for a reader who may judge it; null otherwise. */
  question: string | null;
  proposal: string | null;
};

export type DmAttention = { dbNowMs: number; total: number; items: DmAttentionItem[] };

/**
 * The requests in AMUX › Execution's attention lane, from the newest requests
 * the Admin list reads (DM_ADMIN_REQUEST_LIST_LIMIT). Bodies are read one
 * request at a time and only when `withBodies` -- the judging permission --
 * and a body that cannot be read leaves that card's text out, not the card.
 */
export async function readDecisionMakerAttentionForAdmin({ withBodies }: { withBodies: boolean }): Promise<DmAttention> {
  const list = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestListRead,
    (tx) => listDecisionMakerRequestsForAdmin(tx));
  const waiting = list.rows.flatMap((row) => {
    const kind = dmAdminAttentionKind(row, list.dbNowMs);
    return kind === null ? [] : [{ row, kind }];
  });
  const items = await Promise.all(waiting.slice(0, DM_ATTENTION_SHOWN_LIMIT).map(async ({ row, kind }) => {
    const detail = withBodies
      ? await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestDetailRead,
        (tx) => readDecisionMakerRequestDetailForAdmin(tx, row.requestId)).catch(() => null)
      : null;
    const option = detail?.optionId != null
      ? detail.card?.options.find((entry) => entry.id === detail.optionId)
      : undefined;
    const proposal = detail === null ? null
      : detail.optionId !== null ? `${detail.optionId}${option ? ` · ${option.label}` : ""}`
        : detail.operatorAnswer ?? detail.answer;
    return {
      requestId: row.requestId,
      cardId: row.cardId,
      questionRevision: row.questionRevision,
      askingWorkerId: row.askingWorkerId,
      instance: row.instance,
      kind,
      irreversible: row.irreversible,
      createdAtMs: row.createdAtMs,
      question: detail?.card?.question ?? null,
      proposal,
    } satisfies DmAttentionItem;
  }));
  return { dbNowMs: list.dbNowMs, total: waiting.length, items };
}

/** The same set, counted, for the sidebar badge. */
export async function countDecisionMakerAttention(): Promise<number> {
  const list = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestListRead,
    (tx) => listDecisionMakerRequestsForAdmin(tx));
  return list.rows.filter((row) => dmAdminAttentionKind(row, list.dbNowMs) !== null).length;
}
