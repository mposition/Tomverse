"use client";
import type { AmuxOwnerQueueGroup } from "@/lib/amux/ownerQueueCore";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Eye, Gavel, MessageSquare, MoveRight, Wrench } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminChannelIcon, adminChannelName } from "@/components/admin/ui/AdminChannelIcon";
import {
  AMUX_ATTENTION_GROUPS, amuxAttentionCounts, amuxAttentionCountsFromQueue, amuxAttentionGroup, type AmuxAttentionGroup,
} from "@/lib/adminAmuxBoardView";
import { amuxBoardCardStuck, type AmuxWorkerChannel } from "@/lib/adminAmuxFlow";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";

/** The fields of a board card this column reads. */
export type AttentionLaneCard = {
  id: string;
  title: string | null;
  displayKey: string | null;
  attentionReason: string | null;
  ownerQuestion: "open" | "answered" | null;
  worker: string | null;
  sev1: boolean;
};

const GROUP_ICON: Record<AmuxAttentionGroup, typeof Gavel> = {
  decision: Gavel, question: MessageSquare, recovery: Wrench, read: Eye,
};

/** The most rows the column shows; the rest are one click away in the tab. */
/** The owner queue summary the page passes down (lib/amux/adminOwnerQueueRead.ts). */
export type AmuxBoardOwnerQueue = {
  total: number;
  groups: Record<AmuxOwnerQueueGroup, number>;
  /** The groups count only the cards read, fewer than `total`. */
  partial: boolean;
};

export const AMUX_ATTENTION_LANE_ROWS = 5;

/**
 * The board's "waiting on you" column, shortened: how many cards wait for each
 * of four things (decide, answer, recover, read), the first few as one line
 * each, and one link to the tab that handles all of them.
 *
 * It draws what the board read and decides nothing. A card still opens its
 * detail (which opens on the owner review when one is waiting), and the review
 * and safety links are the ones the full cards had.
 */
export function AmuxBoardAttentionLane({
  cards, countedCards, cardTotal, decisionMakerTotal, decisionMakerRows, decisionMakerNote, canReviewCards,
  workerChannels, onOpen, ownerQueue,
}: {
  /**
   * The "Waiting on me" queue as the page read it: the same count the tab and
   * the sidebar badge show, and its groups. Absent or null (not read): the
   * counts fall back to the cards the board loaded, marked partial.
   */
  ownerQueue?: AmuxBoardOwnerQueue | null;
  /** The attention-lane cards the board loaded, after the search and filters. */
  cards: readonly AttentionLaneCard[];
  /** Every attention-lane card loaded, before the search and filters: the four counts are of these. */
  countedCards: readonly AttentionLaneCard[];
  /** The server's count of attention cards, which can be more than were loaded. */
  cardTotal: number;
  decisionMakerTotal: number;
  /** One line per Decision Maker request, drawn by the board; they come first. */
  decisionMakerRows: readonly ReactNode[];
  /** A note under the rows (unavailable, hidden bodies). */
  decisionMakerNote?: ReactNode;
  canReviewCards: boolean;
  workerChannels?: Record<string, AmuxWorkerChannel> | null;
  onOpen: (taskId: string, preferOverview: boolean, opener: HTMLElement) => void;
}) {
  const v = useAdminMessages(adminAmuxBoardViewsMessages).attention;
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const screens = useAdminMessages(adminAmuxScreensMessages).board;
  // One number: the tab, the sidebar badge and this column count the same queue.
  // Decision Maker requests are listed here but are not cards in that queue.
  const counts = ownerQueue ? amuxAttentionCountsFromQueue(ownerQueue.groups) : amuxAttentionCounts(countedCards);
  // Cards not read yet are in no count: say so rather than show a smaller number as the whole.
  const partial = ownerQueue ? ownerQueue.partial : countedCards.length < cardTotal;
  const total = ownerQueue ? ownerQueue.total : cardTotal;
  const room = Math.max(0, AMUX_ATTENTION_LANE_ROWS - decisionMakerRows.length);
  const shownCards = cards.slice(0, room);
  const hidden = Math.max(0, total - shownCards.length) + Math.max(0, decisionMakerTotal - decisionMakerRows.length);
  return <div className="flex flex-col gap-2" data-testid="amux-attention-lane">
    <Link href="/admin/amux-execution?tab=review" prefetch={false} data-testid="amux-attention-open-tab"
      className="flex min-h-12 items-center gap-3 rounded-xl bg-amber-600 px-3 py-2 text-white hover:bg-amber-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{v.open}</span>
        <span className="block text-xs opacity-90">{v.openDetail(total)}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
    </Link>
    <ul className="grid grid-cols-2 gap-1.5" aria-label={v.groupsLabel} data-testid="amux-attention-groups">
      {AMUX_ATTENTION_GROUPS.map((group) => {
        const Icon = GROUP_ICON[group];
        return <li key={group} data-group={group}
          className="flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300">
          <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{v.groups[group]}</span>
          <strong className="tabular-nums text-white" data-testid={"amux-attention-group-" + group}
            data-partial={partial ? "true" : undefined}>{counts[group]}{partial ? "+" : ""}</strong>
        </li>;
      })}
    </ul>
    {decisionMakerRows.length > 0 && <ol className="flex flex-col gap-1.5" data-testid="amux-dm-attention-list">
      {decisionMakerRows}
    </ol>}
    {shownCards.length > 0 && <ol className="flex flex-col gap-1.5" aria-label={v.listLabel}>
      {shownCards.map((card) => {
        const group = amuxAttentionGroup(card);
        const stuck = amuxBoardCardStuck({ lane: "attention", attentionReason: card.attentionReason, ownerQuestion: card.ownerQuestion });
        const reason = card.attentionReason ? m.attentionReason[card.attentionReason] ?? m.attentionReasonFallback : null;
        const channel = card.worker ? workerChannels?.[card.worker] ?? null : null;
        const label = amuxVisibleInspectionText(card.displayKey ?? card.id);
        const title = amuxVisibleInspectionText(card.title ?? m.protectedTitle);
        return <li key={card.id} data-testid={"amux-board-card-" + card.id} data-stuck={stuck ? "true" : undefined}
          data-attention-group={group} title={reason ?? undefined}
          className={"flex min-h-10 items-center gap-2 rounded-xl border bg-zinc-900 px-2.5 py-1.5 text-xs " +
            (stuck ? "border-red-500/60" : "border-zinc-800")}>
          <span aria-hidden="true" className={"h-2 w-2 shrink-0 rounded-full " +
            (stuck ? "bg-red-500" : group === "question" ? "bg-blue-500" : "bg-amber-500")} />
          <button type="button" className="shrink-0 font-mono text-[11px] font-bold text-blue-300 hover:underline"
            onClick={(event) => onOpen(card.id, false, event.currentTarget)}>{label}</button>
          {channel && <AdminChannelIcon channel={channel} size={16} label={adminChannelName(channel)} />}
          {card.sev1 && <span className="shrink-0 font-bold text-amber-300">SEV1</span>}
          <button type="button" className="min-w-0 flex-1 truncate text-left font-medium text-zinc-100 hover:underline"
            onClick={(event) => onOpen(card.id, false, event.currentTarget)}>{title}</button>
          {reason && <span className="sr-only" data-testid={"amux-card-attention-reason-" + card.id}>{reason}</span>}
          {card.ownerQuestion === "open" && <button type="button" aria-label={m.questionPending}
            data-testid={"amux-card-open-question-" + card.id}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-blue-300 hover:bg-zinc-800"
            onClick={(event) => onOpen(card.id, true, event.currentTarget)}><MoveRight className="h-4 w-4" aria-hidden="true" /></button>}
          {canReviewCards && card.attentionReason && <button type="button" aria-label={m.openOwnerReview}
            data-testid={"amux-card-open-review-" + card.id}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-amber-300 hover:bg-zinc-800"
            onClick={(event) => onOpen(card.id, false, event.currentTarget)}><MoveRight className="h-4 w-4" aria-hidden="true" /></button>}
          {stuck && <Link href="/admin/amux-recovery?tab=safety" aria-label={screens.openSafety}
            data-testid={"amux-card-safety-link-" + card.id}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-300 hover:bg-zinc-800">
            <Wrench className="h-4 w-4" aria-hidden="true" /></Link>}
        </li>;
      })}
    </ol>}
    {decisionMakerNote}
    {hidden > 0 && <Link href="/admin/amux-execution?tab=review" prefetch={false}
      className="flex min-h-9 items-center justify-center rounded-xl border border-dashed border-amber-500/50 text-xs font-medium text-amber-300 hover:bg-zinc-800">
      {v.more(hidden)}</Link>}
  </div>;
}
