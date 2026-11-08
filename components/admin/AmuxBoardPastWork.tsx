"use client";

import { useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminChannelIcon, adminChannelName } from "@/components/admin/ui/AdminChannelIcon";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import {
  AMUX_PAST_WORK_KINDS, amuxAestShort, amuxMatchesSearch, amuxPastWorkKind, type AmuxPastWorkKind,
} from "@/lib/adminAmuxBoardView";
import type { AmuxWorkerChannel } from "@/lib/adminAmuxFlow";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";

/** The fields of an archive-lane card this list reads. */
export type PastWorkCard = {
  id: string;
  title: string | null;
  displayKey: string | null;
  status: string;
  archived: boolean;
  worker: string | null;
  updatedAt: string;
};

const KIND_TONE: Record<AmuxPastWorkKind, AdminTone> = {
  done: "ok", blocked: "bad", cancelled: "idle", archived: "idle", other: "unknown",
};

/**
 * "Past work": the cards that left the board, as a list a person can search and
 * filter. It pages the archive lane exactly as before (the caller loads each
 * page); the filters only narrow the cards loaded so far, which the note says.
 */
export function AmuxBoardPastWork({ cards, total, loading, failed, workerChannels, protectedTitle, onOpen, onLoadMore, onRetry }: {
  cards: readonly PastWorkCard[];
  /** The server's count of cards in the archive lane. */
  total: number | null;
  /** A page is loading. */
  loading: boolean;
  /** The last read of the lane failed; this is never drawn as an empty list. */
  failed: boolean;
  workerChannels?: Record<string, AmuxWorkerChannel> | null;
  protectedTitle: string;
  onOpen: (taskId: string, opener: HTMLElement) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const v = useAdminMessages(adminAmuxBoardViewsMessages);
  const p = v.past;
  const x = useAdminMessages(adminAmuxExecutionMessages);
  const [kind, setKind] = useState<"all" | AmuxPastWorkKind>("all");
  const [query, setQuery] = useState("");
  const kindOf = (card: PastWorkCard) => amuxPastWorkKind(card);
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(kindOf(card), (counts.get(kindOf(card)) ?? 0) + 1);
  const matches = cards.filter((card) => (kind === "all" || kindOf(card) === kind) &&
    amuxMatchesSearch(query, [card.title, card.displayKey, card.id, card.worker]));
  const remaining = total === null ? 0 : Math.max(0, total - cards.length);
  return <section aria-labelledby="amux-past-work-title" data-testid="amux-past-work"
    className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-zinc-800 px-5 py-4">
      <div className="min-w-0 flex-1 basis-60">
        <h3 id="amux-past-work-title" className="text-base font-bold text-white">{p.title}</h3>
        {total !== null && <p className="mt-0.5 text-xs text-zinc-400">{p.lede(total)}</p>}
      </div>
      <div role="group" aria-label={p.filterLabel} className="flex flex-wrap items-center gap-2">
        {(["all", ...AMUX_PAST_WORK_KINDS] as const).map((item) => {
          const active = kind === item;
          const count = item === "all" ? cards.length : counts.get(item) ?? 0;
          return <button key={item} type="button" aria-pressed={active} onClick={() => setKind(item)}
            data-testid={"amux-past-work-filter-" + item}
            className={"inline-flex min-h-8 items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-bold transition " +
              (active ? "bg-zinc-100 text-zinc-900" : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800")}>
            {item === "all" ? p.all : v.status[item]}
            <span className={"font-mono tabular-nums " + (active ? "text-zinc-600" : "text-zinc-500")}>{count}</span>
          </button>;
        })}
      </div>
      <label className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-xs sm:w-56">
        <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
        <input aria-label={p.searchLabel} placeholder={p.search} value={query} maxLength={120}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
        {query && <button type="button" aria-label={x.clearSearch} onClick={() => setQuery("")}>
          <X className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /></button>}
      </label>
    </div>
    {failed && <div className="p-4">
      <AdminStateBlock kind="error" title={p.unavailableTitle} detail={p.unavailableDetail} onRetry={onRetry} /></div>}
    {!failed && cards.length === 0 && !loading && <p className="px-5 py-6 text-sm text-zinc-400">{p.empty}</p>}
    {!failed && cards.length === 0 && loading && <div className="p-4"><AdminStateBlock kind="loading" /></div>}
    {cards.length > 0 && <>
      {matches.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-400">{p.noMatches}</p> :
        <ul className="flex flex-col">
          {matches.map((card) => {
            const group = kindOf(card);
            const channel = card.worker ? workerChannels?.[card.worker] ?? null : null;
            const label = amuxVisibleInspectionText(card.displayKey ?? card.id);
            const title = amuxVisibleInspectionText(card.title ?? protectedTitle);
            return <li key={card.id} className="border-t border-zinc-800 first:border-t-0">
              <button type="button" data-testid={"amux-past-work-card-" + card.id}
                onClick={(event) => onOpen(card.id, event.currentTarget)}
                className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left text-sm hover:bg-zinc-950/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400">
                <AdminStatusChip tone={KIND_TONE[group]}>{v.status[group]}</AdminStatusChip>
                <span className="shrink-0 rounded-md bg-blue-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-blue-300">{label}</span>
                <span className="min-w-0 flex-1 basis-48 truncate font-medium text-zinc-100">{title}</span>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
                  {channel && <AdminChannelIcon channel={channel} size={16} />}
                  {card.worker ? <span>{channel ? adminChannelName(channel) : card.worker}</span> : <span>{p.noWorker}</span>}
                </span>
                <time dateTime={card.updatedAt} title={formatAestDateTime(card.updatedAt) ?? undefined}
                  className="shrink-0 font-mono text-xs tabular-nums text-zinc-500">{amuxAestShort(card.updatedAt) ?? "-"}</time>
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
              </button>
            </li>;
          })}
        </ul>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3 text-xs text-zinc-400">
        <span>{total === null ? cards.length : p.shown(cards.length, total)} · {p.loadedNote}</span>
        {remaining > 0 && <button type="button" disabled={loading} onClick={onLoadMore} data-testid="amux-past-work-more"
          className="min-h-9 font-bold text-blue-300 hover:underline disabled:opacity-50">{p.more(remaining)}</button>}
      </div>
    </>}
  </section>;
}
