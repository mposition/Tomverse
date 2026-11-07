import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";

import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { amuxBarFraction, amuxCardStatusGroup, type AmuxCardStatusGroup } from "@/lib/adminAmuxFlow";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAmuxBacklogListMessages } from "@/lib/adminMessages/amuxBacklogList";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { formatAestDate, type AdminTone } from "@/lib/adminUiCore";
import { amuxBacklogHref } from "@/lib/amux/adminBacklogListCore";
import type { AmuxBacklogList } from "@/lib/amux/adminBacklogRead";

/** What the newest cards say about themselves; the paged list rows do not carry it. */
export type AmuxBacklogCardSummary = {
  total: number;
  limit: number;
  cards: Array<{ id: string; status: string; kind: string; priority: string }>;
};

const STATUS_TONE: Record<AmuxCardStatusGroup, AdminTone> = {
  waiting: "idle",
  running: "info",
  review: "warn",
  done: "ok",
  blocked: "bad",
  cancelled: "idle",
  other: "unknown",
};

type Row = AmuxBacklogList["rows"][number];

/**
 * The card list: a count per state, then every card with its kind, priority,
 * portfolio score and state. The page of cards is the existing paged read;
 * the counts and each card's kind, priority and state come from the newest
 * cards' own read (`summary`), which is bounded and says so. A card older than
 * that read has no state to show, and a failed read draws "unavailable", never
 * a zero.
 */
export async function AmuxBacklogListPanel({ data, search, valid, summary }: {
  data: AmuxBacklogList | null; search: string; valid: boolean;
  /** null: the newest-cards read failed or was not made. */
  summary: AmuxBacklogCardSummary | null;
}) {
  const [m, s] = await Promise.all([getAdminMessages(adminAmuxBacklogListMessages), getAdminMessages(adminAmuxScreensMessages)]);
  const c = s.cards;
  const iconClass = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-700 hover:bg-zinc-800";
  const meta = new Map((summary?.cards ?? []).map((card) => [card.id, card]));
  const counts: Record<AmuxCardStatusGroup, number> = { waiting: 0, running: 0, review: 0, done: 0, blocked: 0, cancelled: 0, other: 0 };
  for (const card of summary?.cards ?? []) counts[amuxCardStatusGroup(card.status)] += 1;
  const bounded = summary !== null && summary.total > summary.cards.length;
  // A status the table does not know is shown as it is stored (an identifier).
  const statusWord = (status: string) => {
    const group = amuxCardStatusGroup(status);
    return group === "other" ? status : c.status[group];
  };

  const columns: AdminDataColumn<Row>[] = [
    {
      key: "card",
      header: m.cardNumber,
      render: (row) => (
        <span className="flex min-w-0 flex-col gap-1" data-testid="amux-backlog-row">
          <Link
            className="w-fit rounded-md bg-cyan-500/15 px-2 py-0.5 font-mono text-xs font-bold text-cyan-300 hover:underline"
            href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(row.id)}`}
            title={row.id}
          >
            {row.cardNumber}
          </Link>
          <span className="block max-w-md truncate text-zinc-100" title={row.summary ?? undefined}>
            {row.summary ?? (row.summaryUnavailable ? m.summaryUnavailable : m.summaryNotStored)}
          </span>
        </span>
      ),
    },
    {
      key: "kind",
      header: c.columns.kind,
      render: (row) => <span className="font-mono text-xs text-zinc-300">{meta.get(row.id)?.kind ?? c.notInNewest}</span>,
    },
    {
      key: "priority",
      header: c.columns.priority,
      render: (row) => <span className="font-mono text-xs font-bold uppercase text-zinc-300">{meta.get(row.id)?.priority ?? c.notInNewest}</span>,
    },
    {
      key: "score",
      header: m.score,
      render: (row) => {
        const fraction = amuxBarFraction(row.score, 100);
        return row.score === null || fraction === null ? (
          <span className="text-xs text-zinc-400">{m.unscored}</span>
        ) : (
          <span className="flex items-center gap-2">
            <span
              role="progressbar"
              aria-label={m.score}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.score}
              className="h-2 w-24 overflow-hidden rounded-full bg-zinc-800"
            >
              <span className="block h-full rounded-full bg-cyan-500" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </span>
            <span className="font-bold tabular-nums text-zinc-100">{row.score}</span>
            {!row.scoreFresh ? <span className="text-xs text-amber-300">{m.stale}</span> : null}
          </span>
        );
      },
    },
    {
      key: "created",
      header: m.createdAt,
      render: (row) => <time dateTime={row.createdAt} title={row.createdAt} className="text-xs text-zinc-400">{formatAestDate(row.createdAt) ?? "-"}</time>,
    },
    {
      key: "status",
      header: c.columns.status,
      render: (row) => {
        const card = meta.get(row.id);
        if (!card) return <span className="text-xs text-zinc-500" title={c.notInNewestHint}>{c.notInNewest}</span>;
        const group = amuxCardStatusGroup(card.status);
        return <AdminStatusChip tone={STATUS_TONE[group]}>{statusWord(card.status)}</AdminStatusChip>;
      },
    },
  ];

  // Kept on every branch that has a valid or an invalid search, so a bad value can be fixed or cleared here.
  const searchForm = (
    <form action="/admin/amux-backlog" method="get" className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="tab" value="list" />
      <label className="flex min-w-0 items-center gap-2 text-sm">
        <span className="sr-only">{m.search}</span>
        <input
          key={search}
          type="search"
          name="cardNumber"
          defaultValue={search}
          maxLength={128}
          placeholder={m.searchPlaceholder}
          className="h-9 w-72 max-w-full rounded-xl border border-zinc-700 bg-transparent px-3"
        />
      </label>
      <button type="submit" className={iconClass} aria-label={m.search} title={m.search}>
        <Search size={16} />
      </button>
      {search && (
        <Link href={amuxBacklogHref("")} className={iconClass} aria-label={m.clear} title={m.clear}>
          <X size={16} />
        </Link>
      )}
    </form>
  );

  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="amux-backlog-list">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="amux-backlog-counts">
        <AdminKpiCard label={c.counts.all} value={summary ? summary.total : null} />
        <AdminKpiCard label={c.counts.waiting} value={summary ? counts.waiting : null} />
        <AdminKpiCard label={c.counts.running} value={summary ? counts.running : null} />
        <AdminKpiCard label={c.counts.review} value={summary ? counts.review : null} />
        <AdminKpiCard label={c.counts.done} value={summary ? counts.done : null} />
      </div>
      {bounded ? <p className="text-xs text-zinc-500" data-testid="amux-backlog-counts-note">{c.bounded(summary.cards.length, summary.total)}</p> : null}
      {!data && valid ? (
        <AdminTile title={m.title}>
          <p className="text-sm text-zinc-300">
            {m.reauthenticate}{" "}
            <Link className="font-medium text-blue-300 underline" href={adminRecentAuthenticationHref(amuxBacklogHref(search))}>
              {m.signIn}
            </Link>
          </p>
        </AdminTile>
      ) : !valid ? (
        <AdminTile>
          {searchForm}
          <AdminStateBlock kind="error" title={m.invalidSearch} />
        </AdminTile>
      ) : data ? (
        <div data-testid="amux-backlog-table">
          <AdminDataTable
            caption={m.title}
            columns={columns}
            rows={data.rows}
            rowKey={(row) => row.id}
            cardTitle={(row) => (
              <Link className="hover:underline" href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(row.id)}`}>
                {row.summary ?? row.cardNumber}
              </Link>
            )}
            cardMeta={(row) => <span className="font-mono">{row.cardNumber}</span>}
            cardAside={(row) => {
              const card = meta.get(row.id);
              return card ? <AdminStatusChip tone={STATUS_TONE[amuxCardStatusGroup(card.status)]}>{statusWord(card.status)}</AdminStatusChip> : null;
            }}
            emptyState={<AdminStateBlock kind="empty" title={search ? m.noMatches : m.empty} />}
            toolbar={
              <>
                {searchForm}
                <p className="ml-auto text-xs text-zinc-400" data-testid="amux-backlog-count">
                  {m.shown(data.rows.length, data.total)}
                </p>
              </>
            }
            footer={
              <nav aria-label={m.page(data.page, data.pageCount)} className="ml-auto flex items-center gap-3">
                {data.page > 1 && (
                  <Link href={amuxBacklogHref(search, data.page - 1)} className={iconClass} aria-label={m.previous} title={m.previous}>
                    <ChevronLeft size={16} />
                  </Link>
                )}
                <span className="text-sm">{m.page(data.page, data.pageCount)}</span>
                {data.page < data.pageCount && (
                  <Link href={amuxBacklogHref(search, data.page + 1)} className={iconClass} aria-label={m.next} title={m.next}>
                    <ChevronRight size={16} />
                  </Link>
                )}
              </nav>
            }
          />
        </div>
      ) : null}
    </section>
  );
}
