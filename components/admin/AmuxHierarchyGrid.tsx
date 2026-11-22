"use client";

import { Archive, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { adminAmuxHierarchyMessages } from "@/lib/adminMessages/amuxHierarchy";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import {
  AMUX_HIERARCHY_CREATED_WITHIN, AMUX_HIERARCHY_SORTS, AMUX_HIERARCHY_STALE_DAYS,
  amuxHierarchyDefaultSort, type AmuxHierarchyRollup, type AmuxHierarchyScope,
  type AmuxHierarchySort, type AmuxHierarchySummary,
} from "@/lib/amux/adminHierarchyCore";
import { AmuxSourceKeySuffix, amuxCardLabel } from "./AmuxCardIdentity";
import { requestAmuxHierarchyArchive } from "./amuxHierarchyArchiveRequest";

type CardItem = { type: "card"; id: string; title: string | null; displayKey: string | null;
  sourceKey: string | null; status: string; cardType: string | null; storyKind: string | null;
  taskRole: string | null; executionGrade: string | null; worker: string | null;
  attentionReason: string | null; progress: { done: number; total: number } | null;
  createdAt?: string; updatedAt: string };
type NodeItem = { type: "node"; id: string; title: string | null; level: string;
  parentId: string | null; createdAt: string; assessment: unknown;
  rollup: AmuxHierarchyRollup; archivable: boolean };
type Item = NodeItem | CardItem;
type Page = { page: number; pageSize: number; total: number; items: Item[] };
type RootPage = Page & { summary: AmuxHierarchySummary; unassignedCount: number;
  archiveEnabled: boolean };
type SearchResult = { query: string; matchedNodes: number; matchedCards: number;
  rows: Array<{ depth: number; match: boolean; item: Item }>; requested: string };
type Parent = { kind: "unassigned" } | { kind: "node" | "story"; id: string };
type FeedbackRollup = { rollup: { taskCount: number; doneCount: number; attemptCount: number;
  approvedCeilingMicrousd: string | null; settledCostMicrousd: string | null;
  incompleteUsageCount: number; checkFindings: number | null;
  independentReviewFindings: number | null } | null };

const DAY = 86_400_000;
const GRID = "grid grid-cols-[minmax(22rem,1fr)_11.5rem_8.5rem_5rem_5.5rem_6rem_19rem]";
const keyOf = (parent: Parent) => parent.kind === "unassigned" ? "unassigned" : `${parent.kind}:${parent.id}`;
const USD = (micro: string | null) => micro === null ? null : (Number(micro) / 1_000_000).toFixed(4);
const assessmentValue = (value: unknown) => value && typeof value === "object" &&
  !Array.isArray(value) && "value" in value && typeof value.value === "number" ? value.value : null;

const LEVEL: Record<string, { short: string; badge: string; bar: string; track: string }> = {
  initiative: { short: "INI", badge: "bg-purple-400/15 text-purple-300", bar: "bg-purple-400", track: "bg-purple-400/30" },
  epic: { short: "EPIC", badge: "bg-orange-400/15 text-orange-300", bar: "bg-orange-400", track: "bg-orange-400/30" },
  feature: { short: "FEAT", badge: "bg-sky-400/15 text-sky-300", bar: "bg-sky-400", track: "bg-sky-400/30" },
  story: { short: "STORY", badge: "bg-emerald-400/15 text-emerald-300", bar: "bg-emerald-400", track: "bg-emerald-400/30" },
  task: { short: "TASK", badge: "bg-yellow-400/15 text-yellow-300", bar: "bg-yellow-400", track: "bg-yellow-400/30" },
  bug: { short: "BUG", badge: "bg-red-400/15 text-red-300", bar: "bg-red-400", track: "bg-red-400/30" },
};
const MIX = [["done", "bg-emerald-400"], ["review", "bg-violet-400"], ["doing", "bg-sky-400"],
  ["todo", "bg-zinc-400"], ["backlog", "bg-zinc-600"], ["attention", "bg-red-400"]] as const;
const CARD_STATUS: Record<string, { key: keyof typeof adminAmuxHierarchyMessages.en.status; tone: string }> = {
  done: { key: "done", tone: "bg-emerald-400/15 text-emerald-300" },
  review: { key: "review", tone: "bg-violet-400/15 text-violet-300" },
  doing: { key: "doing", tone: "bg-sky-400/15 text-sky-300" },
  todo: { key: "todo", tone: "bg-zinc-400/15 text-zinc-300" },
  backlog: { key: "backlog", tone: "bg-zinc-600/30 text-zinc-400" },
  blocked: { key: "attention", tone: "bg-red-400/15 text-red-300" },
  cancelled: { key: "cancelled", tone: "bg-zinc-600/30 text-zinc-500" },
};

const levelOf = (item: Item) => item.type === "node" ? item.level :
  item.cardType === "story" ? "story" : item.storyKind === "bug" ? "bug" : "task";

async function getJson<T>(url: string): Promise<T> {
  const response = await adminFetch(url, { cache: "no-store" });
  if (response.status === 428) throw new Error("reauth");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function Highlight({ text, query }: { text: string; query: string | null }) {
  if (!query) return <>{text}</>;
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-sm bg-amber-400/20 font-semibold text-amber-300 underline">
    {text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

/** The Execution board's hierarchy view: a backlog tree with rollup progress,
 * dates and a timeline (owner decision 2026-11-21). Reads only; the archive
 * action posts through `amuxHierarchyArchiveRequest`. */
export function AmuxHierarchyGrid({ onOpenCard, canArchive }: {
  onOpenCard: (id: string, from: HTMLElement) => void; canArchive: boolean;
}) {
  const h = useAdminMessages(adminAmuxHierarchyMessages);
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const { locale } = useAdminLocale();
  const [scope, setScope] = useState<AmuxHierarchyScope>("active");
  const [sort, setSort] = useState<AmuxHierarchySort>("remaining");
  const [createdWithin, setCreatedWithin] = useState<number | null>(null);
  const [root, setRoot] = useState<RootPage | null>(null);
  const [rootBusy, setRootBusy] = useState(false);
  const [tree, setTree] = useState<Record<string, Page>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, FeedbackRollup>>({});
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootGeneration = useRef(0);
  // When the shown data was read; every "days ago" and the today line use it.
  const [nowMs, setNowMs] = useState(0);

  const loadRoot = useCallback(async (page = 0) => {
    const generation = ++rootGeneration.current;
    setRootBusy(true); setFailed(false);
    const params = new URLSearchParams({ view: "hierarchy", parentKind: "root",
      page: String(page), scope, sort });
    if (createdWithin !== null) params.set("createdWithin", String(createdWithin));
    try {
      const result = await getJson<RootPage>(`/api/admin/amux/execution-view?${params}`);
      if (generation !== rootGeneration.current) return;
      setNowMs(Date.now());
      setRoot((current) => page === 0 || !current ? result :
        { ...result, items: [...current.items, ...result.items] });
    } catch { if (generation === rootGeneration.current) setFailed(true); }
    finally { if (generation === rootGeneration.current) setRootBusy(false); }
  }, [scope, sort, createdWithin]);
  useEffect(() => {
    queueMicrotask(() => { void loadRoot(0); });
    return () => { rootGeneration.current += 1; };
  }, [loadRoot]);

  const loadChildren = useCallback(async (parent: Parent, page = 0) => {
    const key = keyOf(parent);
    setBusy(key); setFailed(false);
    const params = new URLSearchParams({ view: "hierarchy", parentKind: parent.kind, page: String(page) });
    if (parent.kind !== "unassigned") params.set("parentId", parent.id);
    try {
      const result = await getJson<Page>(`/api/admin/amux/execution-view?${params}`);
      setTree((current) => ({ ...current, [key]: page === 0 || !current[key] ? result :
        { ...result, items: [...current[key].items, ...result.items] } }));
    } catch { setFailed(true); }
    finally { setBusy(null); }
  }, []);
  const toggle = (parent: Parent) => {
    const key = keyOf(parent);
    const next = !expanded[key];
    setExpanded((current) => ({ ...current, [key]: next }));
    if (next && !tree[key]) void loadChildren(parent);
  };
  const loadFeedback = async (parent: { kind: "node" | "story"; id: string }) => {
    const params = new URLSearchParams({ view: "feedback", parentKind: parent.kind, parentId: parent.id });
    try {
      const result = await getJson<FeedbackRollup>(`/api/admin/amux/execution-view?${params}`);
      setFeedback((current) => ({ ...current, [keyOf(parent)]: result }));
    } catch { setFailed(true); }
  };

  // Search runs on the server, over every hierarchy and linked card.
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getJson<Omit<SearchResult, "requested">>(`/api/admin/amux/execution-view?${new URLSearchParams({
        view: "hierarchy_search", q: trimmed })}`)
        .then((result) => { if (!cancelled) { setNowMs(Date.now());
          setSearchResult({ ...result, requested: trimmed }); } })
        .catch(() => { if (!cancelled) setFailed(true); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [trimmed]);
  // Results show only for the query in the box; a newer query reads "searching".
  const search = trimmed && searchResult?.requested === trimmed ? searchResult : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey ||
          target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault(); searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const archive = async (ids: string[]) => {
    setArchiving(true); setNotice(null);
    const outcome = await requestAmuxHierarchyArchive(ids);
    setArchiving(false); setConfirming(null); setSelected(new Set());
    if (outcome.state === "archived") setNotice({ tone: "ok", text: h.archived(outcome.count) });
    else if (outcome.state === "refused") setNotice({ tone: "error", text:
      h.archiveRefused[outcome.code as keyof typeof h.archiveRefused] ?? h.archiveFailed });
    else if (outcome.state === "reauth") setNotice({ tone: "error", text: m.reauth });
    else setNotice({ tone: "error", text: h.archiveFailed });
    // Whatever happened, read the hierarchy back before anything else is tried.
    setTree({}); setExpanded({}); setFeedback({});
    void loadRoot(0);
  };

  // One time axis for the whole list, from the oldest shown hierarchy to today.
  const range = useMemo(() => {
    const created = (root?.items ?? []).map((item) => Date.parse(item.createdAt ?? "")).filter(Number.isFinite);
    let start = Math.min(nowMs - 28 * DAY, ...created) - DAY;
    start -= ((new Date(start).getUTCDay() + 6) % 7) * DAY;
    start = Math.floor(start / DAY) * DAY;
    const end = nowMs + 4 * DAY;
    const ticks: number[] = [];
    for (let at = start; at < end; at += 7 * DAY) ticks.push(at);
    return { start, end, ticks };
  }, [root, nowMs]);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms - range.start) / (range.end - range.start) * 100))}%`;
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit",
    timeZone: "Australia/Brisbane" }), [locale]);
  const shortDate = (iso: string | null | undefined) => iso ? dayFormat.format(new Date(iso)) : "—";
  const daysSince = (iso: string) => Math.floor((nowMs - Date.parse(iso)) / DAY);

  const timeline = (item: Item) => {
    const level = LEVEL[levelOf(item)];
    const startMs = Date.parse(item.type === "node" ? item.createdAt : item.createdAt ?? item.updatedAt);
    let endMs: number; let fill: number;
    if (item.type === "node") {
      endMs = item.rollup.remaining > 0 ? nowMs : Date.parse(item.rollup.lastActivityAt ?? item.createdAt);
      fill = item.rollup.total ? item.rollup.done / item.rollup.total : 0;
    } else {
      const closed = item.status === "done" || item.status === "cancelled";
      endMs = closed ? Date.parse(item.updatedAt) : nowMs;
      fill = item.status === "done" ? 1 : 0;
    }
    const height = item.type === "node" ? item.level === "initiative" ? "h-2.5" :
      item.level === "epic" ? "h-2" : "h-1.5" : "h-1";
    const empty = item.type === "node" && item.rollup.total === 0;
    return <div className="relative h-full" aria-hidden="true">
      {range.ticks.map((tick) => <span key={tick} className="absolute inset-y-0 w-px bg-zinc-800" style={{ left: pct(tick) }} />)}
      {empty ? <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-500"
        style={{ left: pct(startMs) }} /> :
        <span className={`absolute top-1/2 -translate-y-1/2 overflow-hidden rounded-full ${height} ${level.track}`}
          style={{ left: pct(startMs), width: `max(4px, calc(${pct(Math.max(endMs, startMs + DAY))} - ${pct(startMs)}))` }}>
          <span className={`block h-full rounded-full ${level.bar}`} style={{ width: `${fill * 100}%` }} />
        </span>}
      <span className="absolute inset-y-0 w-0.5 bg-red-400" style={{ left: pct(nowMs) }} />
    </div>;
  };

  const progressCell = (done: number, total: number) => {
    const full = total > 0 && done === total;
    if (total === 0) return <><span className="h-1.5 w-20 rounded-full bg-zinc-800" />
      <span className="text-xs text-zinc-500">{h.noTasks}</span></>;
    return <><span className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
      <span className={`block h-full rounded-full ${full ? "bg-emerald-400" : "bg-sky-400"}`}
        style={{ width: `${done / total * 100}%` }} /></span>
      <span className="font-mono text-xs text-zinc-100">{done}/{total}</span>
      <span className={`font-mono text-xs ${full ? "text-emerald-300" : "text-zinc-400"}`}>{Math.round(done / total * 100)}%</span></>;
  };
  const mixBar = (rollup: AmuxHierarchyRollup) => {
    const total = MIX.reduce((sum, [key]) => sum + rollup.distribution[key], 0);
    return <span className="flex h-2 w-28 gap-px overflow-hidden rounded-sm bg-zinc-800"
      title={MIX.map(([key]) => `${h.status[key]} ${rollup.distribution[key]}`).join(" · ")}>
      {total > 0 && MIX.map(([key, tone]) => rollup.distribution[key] > 0 &&
        <span key={key} className={tone} style={{ width: `${rollup.distribution[key] / total * 100}%` }} />)}
    </span>;
  };

  const archiveButton = (ids: string[]) => <button type="button" disabled={archiving}
    onClick={() => setConfirming(ids)}
    className="inline-flex items-center gap-1 rounded-md border border-zinc-600 px-2 py-0.5 text-xs text-zinc-100 hover:bg-zinc-800">
    <Archive className="size-3" aria-hidden="true" />{h.archive}</button>;

  const row = (item: Item, depth: number, wbs: string | null,
    opts: { match?: boolean; context?: boolean; selectable?: boolean } = {}): ReactNode => {
    const child: Exclude<Parent, { kind: "unassigned" }> | null = item.type === "node" ? { kind: "node", id: item.id } :
      item.cardType === "story" ? { kind: "story", id: item.id } : null;
    const childKey = child ? keyOf(child) : null;
    const open = childKey ? Boolean(expanded[childKey]) : false;
    const title = amuxVisibleInspectionText(item.title ?? m.protectedTitle);
    const level = LEVEL[levelOf(item)];
    const stale = item.type === "node" && item.rollup.remaining > 0 &&
      daysSince(item.rollup.lastActivityAt ?? item.createdAt) >= AMUX_HIERARCHY_STALE_DAYS;
    const activityIso = item.type === "node" ? item.rollup.lastActivityAt : item.updatedAt;
    const canArchiveRow = item.type === "node" && item.archivable && canArchive &&
      Boolean(root?.archiveEnabled) && !search;
    const status = item.type === "card" ? item.attentionReason ? CARD_STATUS.blocked :
      CARD_STATUS[item.status] ?? CARD_STATUS.todo : null;
    const searchText = search ? search.query : null;
    return <Fragment key={`${item.type}:${item.id}`}>
      <div role="row" aria-level={depth + 1} data-testid={`amux-tree-row-${item.id}`}
        className={`${GRID} min-h-10 items-center border-b border-zinc-800 text-sm ${depth === 0 && !opts.context ?
          "bg-zinc-900/60" : ""} ${opts.match ? "bg-sky-500/10" : ""} ${opts.context ? "opacity-60" : ""}`}>
        <div role="gridcell" className="flex min-w-0 items-center gap-2 py-1.5 pr-3" style={{ paddingLeft: `${12 + depth * 22}px` }}>
          {opts.selectable && <input type="checkbox" aria-label={h.select(title)} disabled={item.type !== "node" || !item.archivable}
            checked={selected.has(item.id)} className="size-4 accent-sky-500"
            onChange={(event) => setSelected((current) => { const next = new Set(current);
              if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />}
          {child && !search ? <button type="button" aria-expanded={open}
            aria-label={m.expand(title)} onClick={() => toggle(child)}
            className="grid size-5 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-800">
            {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          </button> : <span className="size-5 shrink-0" aria-hidden="true" />}
          <span className={`w-11 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold tracking-wide ${level.badge}`}>{level.short}</span>
          {wbs && <span className="shrink-0 font-mono text-xs text-zinc-500">{wbs}</span>}
          {item.type === "card" && <span className="shrink-0 font-mono text-xs text-zinc-400" data-testid="amux-tree-card-label">
            {amuxVisibleInspectionText(amuxCardLabel(item))}
            <AmuxSourceKeySuffix id={item.id} displayKey={item.displayKey} sourceKey={item.sourceKey} m={m} /></span>}
          {item.type === "card" ? <button type="button" className="min-w-0 truncate text-left text-zinc-100 hover:underline"
            onClick={(event) => onOpenCard(item.id, event.currentTarget)}><Highlight text={title} query={searchText} /></button> :
            <span className={`min-w-0 truncate ${depth === 0 ? "font-semibold" : depth === 1 ? "font-medium" : ""} text-zinc-100`}>
              <Highlight text={title} query={searchText} /></span>}
          {item.type === "node" && item.rollup.remaining === 0 && <span className={`shrink-0 rounded-full px-2 text-[11px] font-medium ${
            item.rollup.total > 0 ? "bg-emerald-400/15 text-emerald-300" : "bg-zinc-600/30 text-zinc-400"}`}>
            {item.rollup.total > 0 ? h.chipComplete : h.chipEmpty}</span>}
          {stale && item.type === "node" && <span className="shrink-0 rounded-full bg-amber-400/15 px-2 text-[11px] font-medium text-amber-300">
            {h.stalled(daysSince(item.rollup.lastActivityAt ?? item.createdAt))}</span>}
          {item.type === "node" && assessmentValue(item.assessment) !== null && <span className="shrink-0 text-xs text-zinc-500">
            {m.strategicValue} {assessmentValue(item.assessment)}</span>}
          {child && !search && <button type="button"
            className="shrink-0 text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            onClick={() => void loadFeedback(child)}>{m.feedback}</button>}
        </div>
        <div role="gridcell" className="flex items-center gap-2 px-3">
          {item.type === "node" ? progressCell(item.rollup.done, item.rollup.total) :
            item.progress ? progressCell(item.progress.done, item.progress.total) :
            status && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.tone}`}>{h.status[status.key]}</span>}
        </div>
        <div role="gridcell" className="truncate px-3 text-xs text-zinc-400">
          {item.type === "node" ? mixBar(item.rollup) :
            item.worker ?? `${item.taskRole ?? m.noRole} · ${item.executionGrade ?? m.noGrade}`}
        </div>
        <div role="gridcell" className="px-3 font-mono text-sm">
          {canArchiveRow ? archiveButton([item.id]) : item.type === "node" ?
            item.rollup.remaining > 0 ? <span className="text-zinc-100">{item.rollup.remaining}</span> :
            item.rollup.openCards > 0 ? <span className="font-sans text-xs text-amber-300">{h.archiveBlocked(item.rollup.openCards)}</span> :
            <span className="text-zinc-600">0</span> : null}
        </div>
        <div role="gridcell" className="px-3 font-mono text-xs text-zinc-400" title={formatAestDateTime(item.createdAt ?? "") ?? undefined}>
          {shortDate(item.createdAt)}</div>
        <div role="gridcell" className={`px-3 text-xs ${stale ? "font-medium text-amber-300" : "text-zinc-400"}`}
          title={activityIso ? formatAestDateTime(activityIso) ?? undefined : undefined}>
          {activityIso ? h.ago(daysSince(activityIso)) : h.noActivity}</div>
        <div role="gridcell" className="h-10">{timeline(item)}</div>
      </div>
      {childKey && feedback[childKey] && <p className="border-b border-zinc-800 py-1.5 pr-3 text-xs text-zinc-300"
        style={{ paddingLeft: `${44 + depth * 22}px` }}>
        {feedback[childKey].rollup ? (() => { const s = feedback[childKey].rollup!;
          return `${m.progress(s.doneCount, s.taskCount)} · ${m.attempts} ${s.attemptCount} · ` +
            `${m.approvedCeiling} ${s.approvedCeilingMicrousd === null ? m.unknown : `$${USD(s.approvedCeilingMicrousd)}`} · ` +
            `${m.internalCost} ${s.settledCostMicrousd === null ? m.unknown : `$${USD(s.settledCostMicrousd)}`} · ` +
            `${m.incompleteUsage} ${s.incompleteUsageCount} · ${m.checkFindings} ${s.checkFindings ?? m.unknown} · ` +
            `${m.reviewFindings} ${s.independentReviewFindings ?? m.unknown}`; })() : m.feedbackTooLarge}
      </p>}
      {child && open && !search && children(child, depth + 1, wbs)}
    </Fragment>;
  };
  const moreRow = (shown: number, total: number, onMore: () => void, depth: number, disabled: boolean) =>
    <div className="flex items-center gap-3 border-b border-zinc-800 py-2 text-xs" style={{ paddingLeft: `${44 + depth * 22}px` }}>
      <span className="text-zinc-500">{h.shown(shown, total)}</span>
      <button type="button" disabled={disabled} onClick={onMore}
        className="font-medium text-sky-300 hover:underline">{h.loadMore}</button>
    </div>;
  const children = (parent: Parent, depth: number, wbs: string | null): ReactNode => {
    const key = keyOf(parent);
    const page = tree[key];
    return <>
      {page?.items.map((item, index) => row(item, depth,
        item.type === "node" && wbs ? `${wbs}.${index + 1}` : null))}
      {busy === key && <p className="border-b border-zinc-800 py-2 text-xs text-zinc-500" style={{ paddingLeft: `${44 + depth * 22}px` }}>{h.loading}</p>}
      {page && page.items.length < page.total &&
        moreRow(page.items.length, page.total, () => void loadChildren(parent, page.page + 1), depth, busy !== null)}
    </>;
  };

  const summary = root?.summary;
  const tile = (label: string, value: ReactNode, sub: ReactNode, onClick: (() => void) | null,
    active: boolean, tone = "text-zinc-100") =>
    <button type="button" disabled={!onClick} onClick={onClick ?? undefined}
      className={`flex min-w-0 flex-col gap-1.5 rounded-lg border bg-zinc-900 px-4 py-3 text-left ${active ?
        "border-sky-400" : "border-zinc-800"} ${onClick ? "hover:border-zinc-600" : ""}`}>
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <span className={`text-xl font-bold ${tone}`}>{value}</span>
      <span className="text-xs text-zinc-500">{sub}</span>
    </button>;
  const pick = (nextScope: AmuxHierarchyScope, nextSort = amuxHierarchyDefaultSort(nextScope)) => {
    setQuery(""); setScope(nextScope); setSort(nextSort); setSelected(new Set()); setConfirming(null);
  };
  const selectable = scope === "cleanup" && canArchive && Boolean(root?.archiveEnabled) && !search;

  return <section className="flex flex-col gap-4" data-testid="amux-hierarchy-grid" aria-label={h.title}>
    <div>
      <h3 className="text-lg font-bold text-zinc-100">{h.title}</h3>
      <p className="text-sm text-zinc-400">{h.subtitle}</p>
    </div>
    {summary && <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {tile(h.tiles.progress, <span className="text-sky-300">{h.tileTasks(summary.tasksDone, summary.tasksTotal)}</span>,
        <span className="block h-1.5 overflow-hidden rounded-full bg-zinc-800"><span className="block h-full bg-sky-400"
          style={{ width: `${summary.tasksTotal ? summary.tasksDone / summary.tasksTotal * 100 : 0}%` }} /></span>, null, false)}
      {tile(h.tiles.active, summary.active, h.tileRemaining(summary.remaining), () => pick("active"),
        scope === "active" && sort !== "stale")}
      {tile(h.tiles.stale, summary.stale, h.tileStale(AMUX_HIERARCHY_STALE_DAYS), () => pick("active", "stale"),
        scope === "active" && sort === "stale", "text-amber-300")}
      {tile(h.tiles.complete, summary.complete, h.tileCleanup, () => pick("cleanup"), scope === "cleanup", "text-emerald-300")}
      {tile(h.tiles.empty, summary.empty, h.tileEmpty, () => pick("cleanup"), scope === "cleanup", "text-zinc-300")}
    </div>}
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex h-9 w-80 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 focus-within:border-sky-400">
            <Search className="size-4 text-zinc-500" aria-hidden="true" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)}
              aria-label={h.search} placeholder={h.search} maxLength={80}
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500" />
            {query ? <button type="button" aria-label={h.clearSearch} onClick={() => setQuery("")}>
              <X className="size-4 text-zinc-400" aria-hidden="true" /></button> :
              <kbd className="rounded border border-zinc-700 px-1.5 font-mono text-[11px] text-zinc-500">/</kbd>}
          </label>
          <div role="group" aria-label={h.scopeLabel} className="flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
            {(["active", "cleanup", "all"] as const).map((value) => <button key={value} type="button"
              aria-pressed={scope === value && !search} onClick={() => pick(value)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${scope === value && !search ?
                "bg-zinc-800 font-semibold text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>
              {h.scopes[value]}
              {summary && <span className="font-mono text-[11px] text-zinc-500">{summary[value]}</span>}
            </button>)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">{h.createdLabel}
            <select value={createdWithin ?? ""} onChange={(event) => setCreatedWithin(event.target.value ? Number(event.target.value) : null)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100">
              <option value="">{h.createdAny}</option>
              {AMUX_HIERARCHY_CREATED_WITHIN.map((days) => <option key={days} value={days}>{h.createdWithin(days)}</option>)}
            </select></label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">{h.sortLabel}
            <select value={sort} onChange={(event) => setSort(event.target.value as AmuxHierarchySort)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100">
              {AMUX_HIERARCHY_SORTS.map((value) => <option key={value} value={value}>{h.sorts[value]}</option>)}
            </select></label>
          <button type="button" onClick={() => setExpanded({})}
            className="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">{h.collapseAll}</button>
          {selectable && selected.size > 0 && <button type="button" disabled={archiving}
            onClick={() => setConfirming([...selected])}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500">
            <Archive className="size-3.5" aria-hidden="true" />{h.archiveSelected(selected.size)}</button>}
        </div>
      </div>
      {confirming && <div role="alertdialog" aria-label={h.archive}
        className="flex flex-wrap items-center gap-3 border-b border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
        <span className="min-w-0 flex-1">{h.archiveConfirm(confirming.length)}</span>
        <button type="button" disabled={archiving} onClick={() => void archive(confirming)}
          className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-400">
          {archiving ? h.archiving : h.archiveConfirmButton}</button>
        <button type="button" disabled={archiving} onClick={() => setConfirming(null)}
          className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-100">{h.cancel}</button>
      </div>}
      {notice && <p role="status" className={`border-b border-zinc-800 px-4 py-2 text-sm ${notice.tone === "ok" ?
        "text-emerald-300" : "text-amber-300"}`}>{notice.text}</p>}
      {failed && <p role="alert" className="border-b border-zinc-800 px-4 py-2 text-sm text-red-300">{h.readFailed}</p>}
      {scope === "cleanup" && root && !root.archiveEnabled && canArchive && !search &&
        <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">{h.archiveOff}</p>}
      <div className="flex flex-wrap items-center gap-3.5 border-b border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
        <span>{h.legend}</span>
        {MIX.map(([key, tone]) => <span key={key} className="flex items-center gap-1.5 text-zinc-400">
          <span className={`size-2 rounded-sm ${tone}`} aria-hidden="true" />{h.status[key]}</span>)}
        <span>· {h.timelineLegend}</span>
      </div>
      <div className="overflow-x-auto">
        <div role="treegrid" aria-label={h.title} className="min-w-[78rem]">
          <div role="row" className={`${GRID} h-9 items-center border-b border-zinc-800 bg-zinc-950/60 text-xs font-medium text-zinc-400`}>
            {(["title", "progress", "mix", "remaining", "created", "activity"] as const).map((column) =>
              <div key={column} role="columnheader" className="px-3">{column === "remaining" && scope === "cleanup" ?
                h.archive : h.columns[column]}</div>)}
            <div role="columnheader" className="relative h-full" aria-label={h.columns.timeline}>
              {range.ticks.map((tick) => <span key={tick} className="absolute inset-y-0 border-l border-zinc-800 pl-1 pt-0.5 font-mono text-[10px] text-zinc-500"
                style={{ left: pct(tick) }}>{(tick - range.start) / (range.end - range.start) < 0.9 && dayFormat.format(new Date(tick))}</span>)}
              <span className="absolute bottom-0.5 -translate-x-1/2 rounded bg-red-400 px-1 text-[10px] font-bold text-zinc-950"
                style={{ left: pct(nowMs) }}>{h.today}</span>
            </div>
          </div>
          {search ? <>
            <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
              {search.rows.length ? h.searchResults(search.matchedNodes, search.matchedCards) : h.searchNone}</p>
            {search.rows.map((entry) => row(entry.item, entry.depth, null, { match: entry.match, context: !entry.match }))}
          </> : trimmed ? <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">{h.searching}</p> : <>
            {root?.items.map((item, index) => row(item, 0, String(index + 1), { selectable }))}
            {root && root.items.length === 0 && !rootBusy &&
              <p className="border-b border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">{h.empty[scope]}</p>}
            {rootBusy && <p className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">{h.loading}</p>}
            {root && root.items.length < root.total && <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-xs">
              <span className="text-zinc-500">{h.shown(root.items.length, root.total)}</span>
              <button type="button" disabled={rootBusy} onClick={() => void loadRoot(root.page + 1)}
                className="font-medium text-sky-300 hover:underline">{h.loadMore}</button>
            </div>}
            {scope === "active" && summary && summary.cleanup > 0 && <button type="button" onClick={() => pick("cleanup")}
              className="flex w-full items-center gap-2.5 border-b border-zinc-800 bg-zinc-950/40 px-3 py-3 text-left">
              <ChevronRight className="size-4 text-zinc-400" aria-hidden="true" />
              <span className="text-sm font-semibold text-zinc-100">{h.cleanupGroup}</span>
              <span className="rounded-full bg-zinc-700 px-2 font-mono text-[11px] text-zinc-100">{summary.cleanup}</span>
              <span className="text-xs text-zinc-500">{h.cleanupGroupHint(summary.complete, summary.empty)}</span>
            </button>}
            <button type="button" aria-expanded={Boolean(expanded.unassigned)} onClick={() => toggle({ kind: "unassigned" })}
              className="flex w-full items-center gap-2.5 border-b border-zinc-800 bg-zinc-950/40 px-3 py-3 text-left">
              {expanded.unassigned ? <ChevronDown className="size-4 text-zinc-400" aria-hidden="true" /> :
                <ChevronRight className="size-4 text-zinc-400" aria-hidden="true" />}
              <span className="text-sm font-semibold text-zinc-100">{h.unassigned}</span>
              {root && <span className="rounded-full bg-zinc-700 px-2 font-mono text-[11px] text-zinc-100">{root.unassignedCount}</span>}
              <span className="text-xs text-zinc-500">{h.unassignedHint}</span>
            </button>
            {expanded.unassigned && children({ kind: "unassigned" }, 1, null)}
          </>}
        </div>
      </div>
    </div>
  </section>;
}
