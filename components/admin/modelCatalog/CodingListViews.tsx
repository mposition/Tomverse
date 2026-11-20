"use client";

import { ArrowRight, Search } from "lucide-react";

import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminProviderMark } from "@/components/admin/ui/AdminProviderMark";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { adminCodingCatalogMessages } from "@/lib/adminMessages/codingCatalog";
import {
  CODING_CHANNEL_ORDER,
  type CodingCandidateView,
  type CodingCatalogItem,
  type CodingListFilter,
  type CodingListState,
  type CodingSnapshotView,
  codingAttentionCounts,
  codingListState,
  codingRefusals,
  codingStage,
} from "@/lib/adminModelCatalogFlow";
import type { AdminTone } from "@/lib/adminUiCore";

// The coding tab's list screen (Figma "코딩 카탈로그 시안 v1", 01): summary
// tiles with the Code snapshot, the channel banner, filters, one table for
// both kinds of row, and the chat candidates waiting below it.

export type CodingMessages = AdminMessageShape<(typeof adminCodingCatalogMessages)["en"]>;

const STATE_TONE: Record<CodingListState, AdminTone> = { active: "ok", attention: "warn", inactive: "idle" };

const compactTokens = (tokens: number) =>
  tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);

export const formatTokens = compactTokens;

export function CodingSourceBadge({ c, source }: { c: CodingMessages; source: CodingCatalogItem["source"] }) {
  if (!source) return null;
  return (
    <span
      data-testid="coding-source-badge"
      data-source={source}
      className={`inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-bold ${
        source === "chat" ? "bg-blue-500/15 text-blue-300" : "bg-violet-500/15 text-violet-300"
      }`}
    >
      {c.source[source]}
    </span>
  );
}

export function CodingStateChip({ c, item }: { c: CodingMessages; item: CodingCatalogItem }) {
  const state = codingListState(item);
  return <AdminStatusChip tone={STATE_TONE[state]}>{c.state[state]}</AdminStatusChip>;
}

export function ChannelChips({ c, channels, enabled }: { c: CodingMessages; channels: readonly string[]; enabled: boolean }) {
  if (!enabled) return <span className="text-xs text-zinc-500">{c.list.notOffered}</span>;
  return (
    <span className="flex flex-wrap gap-1" data-testid="coding-channels">
      {CODING_CHANNEL_ORDER.filter((channel) => channels.includes(channel)).map((channel) => (
        <span key={channel} className="rounded-md border border-zinc-700 px-1.5 py-0.5 font-mono text-[11px] font-bold text-zinc-200">
          {c.channel[channel]}
        </span>
      ))}
    </span>
  );
}

function Tile({ label, value, detail, tone, onClick, active }: {
  label: string;
  value: number;
  detail: string;
  tone: "ok" | "warn" | "info";
  onClick?: () => void;
  active?: boolean;
}) {
  const dot = tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-blue-400";
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-bold text-zinc-300">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        {label}
      </span>
      <span className="mt-2 block text-3xl font-bold text-zinc-100">{value}</span>
      <span className="mt-2 block text-xs text-zinc-400">{detail}</span>
    </>
  );
  const className = `flex min-w-0 flex-col rounded-2xl border bg-zinc-900 p-4 text-left ${active ? "border-blue-500" : "border-zinc-800"}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} hover:border-zinc-600`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** The four tiles: active, waiting on a check, chat candidates, and the snapshot. */
export function CodingSummary({
  c,
  items,
  candidateCount,
  snapshot,
  onCandidates,
  candidatesOpen,
  onPublish,
  busy,
  showSnapshot = true,
}: {
  c: CodingMessages;
  items: readonly CodingCatalogItem[];
  candidateCount: number;
  snapshot: CodingSnapshotView | null;
  onCandidates: () => void;
  candidatesOpen: boolean;
  onPublish: () => void;
  busy: boolean;
  showSnapshot?: boolean;
}) {
  const active = items.filter((item) => codingListState(item) === "active").length;
  const inactive = items.filter((item) => codingListState(item) === "inactive").length;
  const attention = codingAttentionCounts(items);
  const attentionCount = attention.floor + attention.terms + attention.other;
  return (
    <div className={`grid min-w-0 gap-3 ${showSnapshot ? "lg:grid-cols-[1fr_1fr_1fr_1.8fr]" : "sm:grid-cols-3"}`} data-testid="coding-summary">
      <Tile label={c.tiles.active} value={active} detail={c.tiles.activeDetail(snapshot?.version ?? null, inactive)} tone="ok" />
      <Tile
        label={c.tiles.attention}
        value={attentionCount}
        detail={c.tiles.attentionDetail(attention.floor, attention.terms, attention.other)}
        tone="warn"
      />
      <Tile
        label={c.tiles.candidates}
        value={candidateCount}
        detail={c.tiles.candidatesDetail}
        tone="info"
        onClick={onCandidates}
        active={candidatesOpen}
      />
      {showSnapshot ? <SnapshotCard c={c} snapshot={snapshot} onPublish={onPublish} busy={busy} /> : null}
    </div>
  );
}

export function SnapshotCard({
  c,
  snapshot,
  onPublish,
  busy,
}: {
  c: CodingMessages;
  snapshot: CodingSnapshotView | null;
  onPublish: () => void;
  busy: boolean;
}) {
  const pending = snapshot?.pendingChanges ?? [];
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-4" data-testid="coding-snapshot">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-bold text-zinc-100">{c.snapshot.title}</h3>
        {snapshot ? <span className="font-mono text-sm font-bold text-blue-300">v{snapshot.version}</span> : null}
        {snapshot ? (
          <AdminStatusChip tone={snapshot.current ? "ok" : "bad"} className="ml-auto">
            {snapshot.current ? c.snapshot.valid : c.snapshot.stale}
          </AdminStatusChip>
        ) : null}
      </div>
      <p className="text-xs text-zinc-400">
        {snapshot
          ? c.snapshot.line(snapshot.modelCount, snapshot.publishedAt.slice(0, 16).replace("T", " "), snapshot.coverageUntil.slice(0, 10))
          : c.snapshot.none}
      </p>
      {snapshot ? (
        pending.length > 0 ? (
          <div className="text-xs font-bold text-amber-300" data-testid="coding-snapshot-pending">
            <p>{c.snapshot.pending(pending.length)}</p>
            <p className="mt-0.5 font-mono font-normal text-amber-200/80">
              {pending.map((change) => `${change.modelId} (${c.snapshot.pendingKind[change.kind]})`).join(" · ")}
            </p>
          </div>
        ) : snapshot.contentHashMatches === false ? (
          <p className="text-xs font-bold text-amber-300" data-testid="coding-snapshot-republish">
            {c.snapshot.republish}
          </p>
        ) : (
          <p className="text-xs text-emerald-300">{c.snapshot.upToDate}</p>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <AdminWriteButton size="sm" onClick={onPublish} disabled={busy} data-testid="coding-publish-snapshot">
          {c.snapshot.publish}
        </AdminWriteButton>
      </div>
      <p className="font-mono text-[11px] text-zinc-500">{c.snapshot.readBy}</p>
    </section>
  );
}

/** Says which callers read this catalogue now, from the switch's state. */
export function CodingChannelBanner({ c, external }: { c: CodingMessages; external: { enabled: boolean; env: string } }) {
  return (
    <div
      role="note"
      data-testid="coding-channel-banner"
      data-external={external.enabled ? "on" : "off"}
      className={`rounded-2xl border p-4 text-sm ${external.enabled ? "border-emerald-500/40 bg-emerald-500/10" : "border-blue-500/40 bg-blue-500/10"}`}
    >
      <p className={`font-bold ${external.enabled ? "text-emerald-300" : "text-blue-300"}`}>
        {external.enabled ? c.banner.onTitle : c.banner.offTitle}
      </p>
      <p className="mt-1 text-zinc-300">{external.enabled ? c.banner.onBody : c.banner.offBody(external.env)}</p>
    </div>
  );
}

const selectClass =
  "min-h-10 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 outline-none focus:border-blue-500";

export function CodingFilterBar({
  c,
  providers,
  filter,
  onChange,
}: {
  c: CodingMessages;
  providers: readonly string[];
  filter: CodingListFilter;
  onChange: (filter: CodingListFilter) => void;
}) {
  const sources: CodingListFilter["source"][] = ["all", "chat", "dedicated"];
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center" data-testid="coding-filter">
      <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3">
        <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        <input
          type="search"
          aria-label={c.filter.search}
          placeholder={c.filter.search}
          value={filter.query}
          onChange={(event) => onChange({ ...filter, query: event.target.value })}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={c.filter.provider}
          value={filter.provider}
          onChange={(event) => onChange({ ...filter, provider: event.target.value })}
          className={selectClass}
        >
          <option value="all">{`${c.filter.provider}: ${c.filter.providerAll}`}</option>
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        <div role="group" aria-label={c.filter.source} className="inline-flex rounded-xl border border-zinc-700 bg-zinc-900 p-0.5">
          {sources.map((source) => (
            <button
              key={source}
              type="button"
              aria-pressed={filter.source === source}
              onClick={() => onChange({ ...filter, source })}
              className={`min-h-9 rounded-lg px-3 text-xs font-bold ${filter.source === source ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
            >
              {source === "all" ? c.filter.sourceAll : c.source[source]}
            </button>
          ))}
        </div>
        <select
          aria-label={c.filter.state}
          value={filter.state}
          onChange={(event) => onChange({ ...filter, state: event.target.value as CodingListFilter["state"] })}
          className={selectClass}
        >
          <option value="all">{`${c.filter.state}: ${c.filter.stateAll}`}</option>
          {(["active", "attention", "inactive"] as const).map((state) => (
            <option key={state} value={state}>
              {c.state[state]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** One line under the status chip: why it waits, or who turned it off. */
const stateDetail = (c: CodingMessages, item: CodingCatalogItem, reasonText: (code: string) => string, changed: boolean) => {
  const stage = codingStage(item);
  if (stage === "held") return item.holdReason ? `${c.stateDetail.held}: ${item.holdReason}` : c.stateDetail.off;
  if (stage === "serving") return changed ? c.stateDetail.snapshotChanged : null;
  if (stage === "draft_ready") return c.stateDetail.draft;
  if (stage === "ready_to_enable") return c.stateDetail.ready;
  const first = codingRefusals(item)[0];
  return first ? reasonText(first) : null;
};

export function CodingModelTable({
  c,
  items,
  pendingIds,
  reasonText,
  onOpen,
}: {
  c: CodingMessages;
  items: readonly CodingCatalogItem[];
  /** Models whose resolved row differs from the newest snapshot. */
  pendingIds: ReadonlySet<string>;
  reasonText: (code: string) => string;
  onOpen: (item: CodingCatalogItem) => void;
}) {
  const col = c.list.columns;
  const columns: AdminDataColumn<CodingCatalogItem>[] = [
    {
      key: "model",
      header: col.model,
      render: (item) => (
        <button type="button" onClick={() => onOpen(item)} className="flex min-w-0 items-center gap-2 text-left">
          <AdminProviderMark provider={item.provider} size={24} />
          <span className="min-w-0">
            <span className="block font-bold text-zinc-100 hover:underline">{item.name}</span>
            <span className="block truncate font-mono text-xs text-zinc-500">
              {item.provider} · {item.apiModelId}
            </span>
          </span>
        </button>
      ),
    },
    { key: "source", header: col.source, render: (item) => <CodingSourceBadge c={c} source={item.source} /> },
    {
      key: "tools",
      header: col.toolCalling,
      render: (item) => <span className="font-mono text-xs text-zinc-200">{item.profile?.capabilities.toolCalling ?? "—"}</span>,
    },
    {
      key: "structured",
      header: col.structuredOutput,
      render: (item) => <span className="font-mono text-xs text-zinc-200">{item.profile?.capabilities.structuredOutput ?? "—"}</span>,
    },
    {
      key: "limits",
      header: col.limits,
      render: (item) =>
        item.profile ? (
          <span className="flex flex-col">
            <span className="font-mono text-xs font-bold text-zinc-100">
              {formatTokens(item.profile.capabilities.maxContextTokens)} / {formatTokens(item.profile.capabilities.maxOutputTokens)}
            </span>
            <span className="text-[11px] text-zinc-500">{item.source === "chat" ? c.list.inherited : c.list.ownValue}</span>
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "plan",
      header: col.plan,
      render: (item) =>
        item.profile ? <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-xs font-bold text-zinc-200">{item.profile.minimumPlan}</span> : "—",
    },
    {
      key: "weight",
      header: col.weight,
      render: (item) => {
        if (!item.profile) return "—";
        const below = item.floor !== null && item.profile.pricing.creditWeight < item.floor;
        return (
          <span className="flex flex-col">
            <span className={`font-mono text-xs font-bold ${below ? "text-amber-300" : "text-zinc-100"}`}>×{item.profile.pricing.creditWeight}</span>
            <span className={`text-[11px] ${below ? "font-bold text-amber-300" : "text-zinc-500"}`}>
              {item.floor === null ? c.list.floorUnknown : below ? c.list.belowFloor(item.floor) : c.list.floor(item.floor)}
            </span>
          </span>
        );
      },
    },
    {
      key: "state",
      header: col.state,
      render: (item) => {
        const detail = stateDetail(c, item, reasonText, pendingIds.has(item.id));
        return (
          <span className="flex flex-col items-start gap-1" data-testid="coding-row-state" data-state={codingListState(item)}>
            <CodingStateChip c={c} item={item} />
            {detail ? <span className="max-w-[14rem] text-[11px] text-zinc-400">{detail}</span> : null}
          </span>
        );
      },
    },
    {
      key: "channels",
      header: col.channels,
      render: (item) => <ChannelChips c={c} channels={item.channels} enabled={codingListState(item) === "active"} />,
    },
  ];
  return (
    <AdminTile
      title={
        <span className="flex items-center gap-2">
          {c.list.title}
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{items.length}</span>
        </span>
      }
      description={c.list.note}
    >
      <div data-testid="coding-model-table">
        <AdminDataTable
          caption={c.list.title}
          columns={columns}
          rows={[...items]}
          rowKey={(item) => item.id}
          cardTitle={(item) => item.name}
          emptyState={<p className="text-sm text-zinc-400">{c.list.empty}</p>}
        />
      </div>
    </AdminTile>
  );
}

/** The chat candidates, folded under the list. */
export function CandidateSummary({ c, candidates, onOpen }: { c: CodingMessages; candidates: readonly CodingCandidateView[]; onOpen: () => void }) {
  if (candidates.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:flex-row sm:items-center"
      data-testid="coding-candidate-summary"
    >
      <div className="flex shrink-0 -space-x-1">
        {candidates.slice(0, 5).map((candidate) => (
          <AdminProviderMark key={candidate.id} provider={candidate.provider} size={28} className="ring-2 ring-zinc-900" />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-zinc-100">
          {c.candidates.title} <span className="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{candidates.length}</span>
        </p>
        <p className="truncate text-xs text-zinc-400">{candidates.map((candidate) => candidate.name).join(" · ")}</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-zinc-700 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
      >
        {c.candidates.summaryOpen}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
