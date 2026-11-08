"use client";

import { useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminChannelIcon, adminChannelName } from "@/components/admin/ui/AdminChannelIcon";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import {
  AMUX_LIST_STATUS_GROUPS, amuxAestShort, amuxAgoText, amuxMatchesSearch, amuxStatusChip,
} from "@/lib/adminAmuxBoardView";
import { amuxCardStatusGroup, type AmuxWorkerChannel } from "@/lib/adminAmuxFlow";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import type { AmuxExecutionListRow } from "@/lib/amux/adminExecutionCardList";

/**
 * The Execution board's List view: every card the owner list read, as one
 * table. A row opens the card's detail, where the worker result, a worker's
 * question and its answer form, the attempts and the technical values (Task ID,
 * source key, brief) are; this table shows none of them and writes nothing.
 */
export function AmuxCardListPanel({ rows, total, limit, nowMs, workerChannels, onOpen }: {
  rows: AmuxExecutionListRow[];
  total: number;
  limit: number;
  /** The clock the "ago" text is counted against, read when the board was read. */
  nowMs: number | null;
  workerChannels?: Record<string, AmuxWorkerChannel> | null;
  onOpen: (taskId: string, opener: HTMLElement) => void;
}) {
  const messages = useAdminMessages(adminAmuxCardsMessages);
  const x = useAdminMessages(adminAmuxExecutionMessages);
  const v = useAdminMessages(adminAmuxBoardViewsMessages);
  const l = v.list;
  const { locale } = useAdminLocale();
  const [group, setGroup] = useState<"all" | (typeof AMUX_LIST_STATUS_GROUPS)[number]>("all");
  const [query, setQuery] = useState("");
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = amuxCardStatusGroup(row.status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const visible = rows.filter((row) => (group === "all" || amuxCardStatusGroup(row.status) === group) &&
    amuxMatchesSearch(query, [row.title, row.displayKey, row.id, row.sourceKey, row.worker]));
  const labelOf = (row: AmuxExecutionListRow) => amuxVisibleInspectionText(row.displayKey ?? row.id);
  const titleOf = (row: AmuxExecutionListRow) => amuxVisibleInspectionText(row.title ?? l.noTitle);
  const open = (row: AmuxExecutionListRow) => (event: { currentTarget: HTMLElement }) => onOpen(row.id, event.currentTarget);
  // A mouse click anywhere in the row's text opens the card; the card cell's button is the keyboard and screen-reader way in.
  const cell = (row: AmuxExecutionListRow, content: React.ReactNode) =>
    <div role="presentation" className="-mx-4 -my-3 cursor-pointer px-4 py-3"
      onClick={(event) => onOpen(row.id, event.currentTarget)}>{content}</div>;
  const worker = (row: AmuxExecutionListRow) => {
    const channel = row.worker ? workerChannels?.[row.worker] ?? null : null;
    return row.worker ? <span className="inline-flex items-center gap-1.5 font-medium text-zinc-100">
      {channel && <AdminChannelIcon channel={channel} size={16} />}
      {channel ? adminChannelName(channel) : row.worker}</span> :
      <span className="text-zinc-500">{l.noWorker}</span>;
  };
  const attempts = (row: AmuxExecutionListRow) => row.attemptCount === 0 ?
    <span className="text-zinc-500">{l.noAttempts}</span> :
    <span>{l.attempts(row.attemptCount)}{row.lastAttemptToStatus ?
      " · " + (l.lastAttempt[row.lastAttemptToStatus] ?? v.status[amuxStatusChip(row.lastAttemptToStatus).group]) : ""}</span>;
  const columns: AdminDataColumn<AmuxExecutionListRow>[] = [
    { key: "card", header: l.columns.card, render: (row) => cell(row,
      <span className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={open(row)} aria-label={l.openRow(labelOf(row))}
          className="shrink-0 rounded-md bg-blue-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
          data-testid="amux-card-row-number">{labelOf(row)}</button>
        <span className="min-w-0 truncate font-medium text-zinc-100">{titleOf(row)}</span>
      </span>) },
    { key: "status", header: l.columns.status, render: (row) => cell(row,
      <AdminStatusChip tone={amuxStatusChip(row.status).tone}>{v.status[amuxStatusChip(row.status).group]}</AdminStatusChip>) },
    { key: "worker", header: l.columns.worker, render: (row) => cell(row, worker(row)) },
    { key: "priority", header: l.columns.priority, render: (row) => cell(row,
      <span className={"font-bold " + (row.priority === "p0" || row.priority === "p1" ? "text-amber-300" : "text-zinc-300")}>
        {row.priority.toUpperCase()}</span>) },
    { key: "attempts", header: l.columns.attempts, render: (row) => cell(row, attempts(row)) },
    { key: "changed", header: l.columns.changed, render: (row) => cell(row,
      <span className="block" title={formatAestDateTime(row.updatedAt) ?? undefined}>
        <span className="block font-mono text-xs font-bold tabular-nums text-zinc-100">{amuxAestShort(row.updatedAt) ?? "-"}</span>
        <span className="block text-xs text-zinc-500">{amuxAgoText(row.updatedAt, nowMs, locale) ?? ""}</span>
      </span>) },
    { key: "open", header: <span className="sr-only">{l.columns.card}</span>, align: "right", hideOnCard: true,
      render: (row) => cell(row, <ChevronRight className="ml-auto h-4 w-4 text-zinc-500" aria-hidden="true" />) },
  ];
  const toolbar = <>
    <label className="flex h-9 min-w-0 flex-1 basis-56 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-xs">
      <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
      <input aria-label={l.searchLabel} placeholder={l.search} value={query} maxLength={120}
        onChange={(event) => setQuery(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
      {query && <button type="button" aria-label={x.clearSearch} onClick={() => setQuery("")}>
        <X className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" /></button>}
    </label>
    <div role="group" aria-label={l.filterLabel} className="flex flex-wrap items-center gap-2">
      {(["all", ...AMUX_LIST_STATUS_GROUPS] as const).map((item) => {
        const active = group === item;
        return <button key={item} type="button" aria-pressed={active} onClick={() => setGroup(item)}
          data-testid={"amux-card-list-filter-" + item}
          className={"inline-flex min-h-8 items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-bold transition " +
            (active ? "bg-zinc-100 text-zinc-900" : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800")}>
          {item === "all" ? l.all : v.status[item]}
          <span className={"font-mono tabular-nums " + (active ? "text-zinc-600" : "text-zinc-500")}>
            {item === "all" ? rows.length : counts.get(item) ?? 0}</span>
        </button>;
      })}
    </div>
  </>;
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="amux-card-list-panel" aria-label={l.caption}>
      <AdminDataTable columns={columns} rows={visible} rowKey={(row) => row.id} caption={l.caption}
        toolbar={toolbar}
        cardTitle={(row) => <button type="button" onClick={open(row)} className="max-w-full truncate text-left">
          <span className="font-mono text-[11px] text-blue-300">{labelOf(row)}</span> {titleOf(row)}</button>}
        cardMeta={(row) => <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AdminStatusChip tone={amuxStatusChip(row.status).tone}>{v.status[amuxStatusChip(row.status).group]}</AdminStatusChip>
          {worker(row)}<span>{amuxAestShort(row.updatedAt) ?? "-"}</span></span>}
        cardAside={() => <ChevronRight className="h-4 w-4 text-zinc-500" aria-hidden="true" />}
        emptyState={<AdminStateBlock kind="empty" title={rows.length === 0 ? l.empty : l.noMatches} />}
        footer={<p className="text-xs text-zinc-400">
          <span data-testid="amux-card-list-count">{messages.shown(rows.length, total, limit)}</span> · {l.hint}</p>} />
    </section>
  );
}
