"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ClipboardCheck,
  Eye,
  Maximize2,
  MessageSquare,
  Minimize2,
  Search,
  Wrench,
} from "lucide-react";

import {
  useAmuxOwnerReview,
  visibleAmuxOwnerReviewOutcomes,
} from "@/components/admin/AdminAmuxRoutingPanel";
import {
  AmuxOwnerQueueDecision,
  useAmuxOwnerQueueElapsed,
} from "@/components/admin/AmuxOwnerQueueDecision";
import { AdminChannelIcon } from "@/components/admin/ui/AdminChannelIcon";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { adminAmuxOwnerQueueMessages } from "@/lib/adminMessages/amuxOwnerQueue";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import {
  AMUX_OWNER_QUEUE_GROUPS,
  amuxOwnerQueueGroup,
  amuxOwnerQueueGroupCounts,
  amuxOwnerQueueVisible,
  type AmuxOwnerQueueGroup,
  type AmuxOwnerQueueItem,
  type AmuxOwnerQueueRead,
} from "@/lib/amux/ownerQueueCore";

const GROUP_ICON = {
  decide: ClipboardCheck, question: MessageSquare, recover: Wrench, read: Eye,
} as const satisfies Record<AmuxOwnerQueueGroup, unknown>;

const GROUP_DOT: Record<AmuxOwnerQueueGroup, string> = {
  decide: "bg-amber-400", question: "bg-blue-400", recover: "bg-red-400", read: "bg-zinc-500",
};

/** Whether a value is a read this screen can draw; anything else is a failed read. */
export const isAmuxOwnerQueueRead = (value: unknown): value is AmuxOwnerQueueRead => {
  if (!value || typeof value !== "object") return false;
  const read = value as Partial<AmuxOwnerQueueRead>;
  return Array.isArray(read.items) && typeof read.total === "number" &&
    typeof read.generatedAt === "string" &&
    (read.processedToday === null || typeof read.processedToday === "number") &&
    read.items.every((item) => item && typeof item.taskId === "string" &&
      typeof item.waitingSince === "string");
};

export type AmuxOwnerQueueStatus = "loading" | "failed" | "ready";

/**
 * "Waiting on me", drawn: the strip, the grouped list and the slot for the
 * decision. It holds no state and reads nothing, so every state it can be in
 * (loading, failed, empty, partial, a card chosen) renders without a browser.
 */
export function AmuxOwnerQueueView({
  status, read, selectedId, onSelect, navLocked, query, onQuery, groupFilter, onGroupFilter,
  focusMode, onToggleFocus, onRetry, detail,
}: {
  status: AmuxOwnerQueueStatus;
  read: AmuxOwnerQueueRead | null;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  navLocked: boolean;
  query: string;
  onQuery: (query: string) => void;
  groupFilter: AmuxOwnerQueueGroup | null;
  onGroupFilter: (group: AmuxOwnerQueueGroup | null) => void;
  focusMode: boolean;
  onToggleFocus: () => void;
  onRetry: () => void;
  detail: ReactNode;
}) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  const execution = useAdminMessages(adminAmuxExecutionMessages);
  const elapsed = useAmuxOwnerQueueElapsed(read?.generatedAt ?? new Date(0).toISOString());
  const items = useMemo(() => read?.items ?? [], [read]);
  const counts = useMemo(() => amuxOwnerQueueGroupCounts(items), [items]);
  const visible = useMemo(
    () => amuxOwnerQueueVisible(items, { group: groupFilter, query }), [items, groupFilter, query]);
  const partial = read !== null && read.total > read.items.length;
  const processed = read?.processedToday ?? null;
  const progress = processed !== null && read !== null && processed + read.total > 0
    ? Math.round((processed / (processed + read.total)) * 100) : null;

  return (
    <div data-testid="amux-owner-queue" data-focus={focusMode ? "true" : "false"} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-5 py-3"
        data-testid="amux-owner-queue-strip">
        <div className="flex items-center gap-3 text-sm text-zinc-300">
          <span>{copy.strip.processedToday}</span>
          <strong className="text-base text-white" data-testid="amux-owner-queue-processed">
            {processed === null ? copy.strip.unknown : processed}
          </strong>
          {progress !== null ? (
            <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
              aria-label={copy.strip.processedToday}
              className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-zinc-800 sm:block">
              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-300">
          <span>{copy.strip.remaining}</span>
          <strong className="text-base text-white" data-testid="amux-owner-queue-remaining">
            {read === null ? copy.strip.unknown : read.total}
          </strong>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="hidden items-center gap-1.5 text-xs text-zinc-400 md:flex" data-testid="amux-owner-queue-keys">
            <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">J</kbd>
            <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">K</kbd>
            {copy.strip.move}
            <span aria-hidden>·</span>
            <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">1</kbd>
            <span aria-hidden>–</span>
            <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">3</kbd>
            {copy.strip.pick}
          </p>
          <button type="button" onClick={onToggleFocus} aria-pressed={focusMode}
            data-testid="amux-owner-queue-fullscreen"
            className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800">
            {focusMode ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
            {focusMode ? copy.strip.exitFullscreen : copy.strip.fullscreen}
          </button>
        </div>
      </div>

      {status === "loading" && read === null ? (
        <AdminStateBlock kind="loading" />
      ) : status === "failed" || read === null ? (
        <div data-testid="amux-owner-queue-failed">
          <AdminStateBlock kind="error" title={copy.failed.title} detail={copy.failed.detail} onRetry={onRetry} />
        </div>
      ) : items.length === 0 ? (
        <div data-testid="amux-owner-queue-empty">
          <AdminStateBlock kind="empty" title={copy.empty.title} detail={copy.empty.detail} />
        </div>
      ) : (
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <section aria-label={copy.list.listLabel}
            className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4"
            data-testid="amux-owner-queue-list">
            <label className="relative block">
              <span className="sr-only">{copy.list.searchLabel}</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
              <input type="search" value={query} onChange={(event) => onQuery(event.target.value)}
                placeholder={copy.list.searchPlaceholder} data-testid="amux-owner-queue-search"
                className="min-h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500" />
            </label>
            <div role="group" aria-label={copy.list.groupsLabel} className="flex flex-wrap gap-2">
              {([null, ...AMUX_OWNER_QUEUE_GROUPS] as const).map((group) => {
                const active = groupFilter === group;
                return (
                  <button key={group ?? "all"} type="button" aria-pressed={active}
                    onClick={() => onGroupFilter(group)} data-testid={`amux-owner-queue-chip-${group ?? "all"}`}
                    className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-bold ${
                      active ? "bg-blue-500/20 text-blue-200" : "text-zinc-400 hover:bg-zinc-800"}`}>
                    {group === null ? copy.list.all : copy.list.groups[group]}
                    <span className="font-normal text-zinc-300">{group === null ? items.length : counts[group]}</span>
                  </button>
                );
              })}
            </div>
            {partial ? (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200"
                data-testid="amux-owner-queue-partial">
                {copy.list.partial(read.items.length, read.total)}
              </p>
            ) : null}
            {visible.length === 0 ? (
              <p className="text-sm text-zinc-400">{copy.list.noMatches}</p>
            ) : AMUX_OWNER_QUEUE_GROUPS.map((group) => {
              const rows = visible.filter((item) => amuxOwnerQueueGroup(item) === group);
              if (rows.length === 0) return null;
              const Icon = GROUP_ICON[group];
              return (
                <section key={group} aria-label={copy.list.headings[group]} data-group={group}>
                  <h3 className="mb-1.5 flex items-center gap-2 px-1 text-xs font-bold text-zinc-300">
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {copy.list.headings[group]}
                    <span className="font-normal text-zinc-500">{rows.length}</span>
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {rows.map((item) => {
                      const selected = item.taskId === selectedId;
                      const reason = item.attentionReason === null ? null
                        : execution.attentionReason[item.attentionReason] ?? execution.attentionReasonFallback;
                      return (
                        <li key={item.taskId}>
                          <button type="button" onClick={() => onSelect(item.taskId)} disabled={navLocked && !selected}
                            aria-current={selected ? "true" : undefined}
                            data-testid="amux-owner-queue-item" data-task-id={item.taskId} data-group={group}
                            className={`flex w-full min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left disabled:opacity-60 ${
                              selected ? "border-amber-500/50 bg-amber-500/10" : "border-transparent hover:bg-zinc-800/70"}`}>
                            <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${GROUP_DOT[group]}`} />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-mono text-xs font-bold text-cyan-300">
                                  {amuxVisibleInspectionText(item.displayKey ?? item.taskId)}
                                </span>
                                <span className="text-xs text-zinc-400">{reason ?? copy.group[group]}</span>
                                {item.publicationPathMissing ? (
                                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-xs font-bold text-amber-200"
                                    data-testid="amux-owner-queue-publication-path-missing">
                                    {copy.list.publicationPathMissing}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block break-words text-sm font-bold text-zinc-100">
                                {item.title === null ? copy.list.untitled : amuxVisibleInspectionText(item.title)}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-zinc-500">
                              {item.channel ? <AdminChannelIcon channel={item.channel} size={18} /> : null}
                              <span>{elapsed(item.waitingSince)}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </section>
          <div className="min-w-0" data-testid="amux-owner-queue-detail">
            {detail ?? <AdminStateBlock kind="empty" title={copy.detail.pickCard} />}
          </div>
        </div>
      )}
    </div>
  );
}

const isEditable = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
};

/**
 * Execution board › Waiting on me. Every card that waits on the owner is read
 * once from `/api/admin/amux/owner-queue`; the owner works through them one by
 * one with the existing review and answer parts on the right. A decision is
 * recorded only by those parts and their routes: this screen reads, selects and
 * moves on, and never skips a confirmation.
 */
export function AmuxOwnerQueueScreen({ canInspectCards, canWriteEngineering = false, focusEscalationId = null }: {
  canInspectCards: boolean;
  /** `engineering-agent:write`: a card's engineering items offer their buttons. */
  canWriteEngineering?: boolean;
  /** A step-up that came back here names the escalation it was working on. */
  focusEscalationId?: string | null;
}) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  const [status, setStatus] = useState<AmuxOwnerQueueStatus>("loading");
  const [read, setRead] = useState<AmuxOwnerQueueRead | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<AmuxOwnerQueueGroup | null>(null);
  const [advance, setAdvance] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const requestId = useRef(0);
  const firstRead = useRef(true);
  const loadRef = useRef<(select?: string | null) => Promise<void>>(async () => {});
  // What the callbacks below need from the latest render without being rebuilt by it.
  const live = useRef<{ visible: AmuxOwnerQueueItem[]; selectedId: string | null; advance: boolean }>(
    { visible: [], selectedId: null, advance: true });

  /** `select`: the card to land on after the read (null: none); omitted keeps the current one. */
  const load = useCallback(async (select?: string | null) => {
    const id = ++requestId.current;
    setStatus("loading");
    try {
      const response = await adminFetch("/api/admin/amux/owner-queue", { cache: "no-store" });
      if (id !== requestId.current) return;
      const body: unknown = response.ok ? await response.json() : null;
      if (id !== requestId.current) return;
      if (!isAmuxOwnerQueueRead(body)) throw new Error("owner queue unreadable");
      const exists = (taskId: string | null) => taskId !== null && body.items.some((item) => item.taskId === taskId);
      const current = live.current.selectedId;
      let next: string | null;
      if (select !== undefined) next = exists(select) ? select : null;
      else if (exists(current)) next = current;
      else if (!firstRead.current) next = null;
      else {
        // The first read opens the card a step-up returned to, else the first one in the list.
        const focused = focusEscalationId === null ? null
          : body.items.find((item) => item.escalationId === focusEscalationId)?.taskId ?? null;
        next = focused ?? amuxOwnerQueueVisible(body.items, { group: null, query: "" })[0]?.taskId ?? null;
      }
      firstRead.current = false;
      setRead(body);
      setStatus("ready");
      setSelectedId(next);
    } catch {
      if (id !== requestId.current) return;
      // A failed read is never an empty list: the list is replaced by the error.
      setRead(null);
      setStatus("failed");
    }
  }, [focusEscalationId]);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const items = useMemo(() => read?.items ?? [], [read]);
  const visible = useMemo(
    () => amuxOwnerQueueVisible(items, { group: groupFilter, query }), [items, groupFilter, query]);
  const selected = items.find((item) => item.taskId === selectedId) ?? null;
  const selectedIndex = selected === null ? -1 : visible.findIndex((item) => item.taskId === selected.taskId);

  // A decision or an answer is final: reload what waits and, when asked, land on the next card.
  useEffect(() => { live.current = { visible, selectedId, advance }; });
  const decided = useCallback(() => {
    const { visible: list, selectedId: current, advance: moveOn } = live.current;
    if (!moveOn) { void loadRef.current(); return; }
    const at = list.findIndex((item) => item.taskId === current);
    void loadRef.current(at < 0 ? null : (list[at + 1] ?? list[at - 1])?.taskId ?? null);
  }, []);
  const reviewer = useAmuxOwnerReview({ canInspectCards, onDecisionCommitted: decided });
  const { selectedEscalationId, pendingDecision, pendingDecisionChecked, openReview, closeReview,
    reviewBusy, decisionStatusUnknown, decisionStatusChecking } = reviewer;
  const navLocked = reviewBusy || decisionStatusUnknown || decisionStatusChecking || pendingDecision !== null;

  // Open the protected review of the chosen card. A card whose question comes
  // first is answered first, so its review is not read until the question is gone.
  const escalationId = selected !== null && amuxOwnerQueueGroup(selected) !== "question" ? selected.escalationId : null;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingDecisionChecked || pendingDecision) return;
    if (escalationId === null) {
      opened.current = null;
      if (selectedEscalationId !== null) closeReview();
      return;
    }
    if (opened.current === escalationId) return;
    opened.current = escalationId;
    queueMicrotask(() => void openReview(escalationId));
  }, [escalationId, selectedEscalationId, pendingDecision, pendingDecisionChecked, openReview, closeReview]);

  // An engineering action on the card: read the queue and this card's review
  // again, staying on the card (its own escalation may have moved on).
  const refreshCard = useCallback(() => {
    void loadRef.current();
    const id = opened.current;
    if (id !== null) queueMicrotask(() => void openReview(id));
  }, [openReview]);

  const select = useCallback((taskId: string) => { if (!navLocked) setSelectedId(taskId); }, [navLocked]);
  const step = useCallback((delta: 1 | -1) => {
    if (selectedIndex < 0) return;
    const target = visible[selectedIndex + delta];
    if (target) select(target.taskId);
  }, [selectedIndex, visible, select]);

  // J and K walk the list; a number only picks the choice the owner then
  // confirms below, so no key skips the confirmation step.
  const keyState = useRef({ step, reviewer, selected });
  useEffect(() => { keyState.current = { step, reviewer, selected }; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { setFocusMode(false); return; }
      if (isEditable(event.target)) return;
      const { step: move, reviewer: controller, selected: card } = keyState.current;
      const key = event.key.toLowerCase();
      if (key === "j") { event.preventDefault(); move(1); return; }
      if (key === "k") { event.preventDefault(); move(-1); return; }
      if (!/^[1-3]$/.test(key)) return;
      const { review, reviewBusy: busy, reauthenticationRequired, decisionStatusUnknown: unknown } = controller;
      if (!review || !card || card.escalationId !== review.escalation.id || amuxOwnerQueueGroup(card) === "question") return;
      if (busy || reauthenticationRequired || unknown) return;
      const outcome = visibleAmuxOwnerReviewOutcomes(review)[Number(key) - 1];
      if (!outcome) return;
      event.preventDefault();
      controller.setSelectedOutcome(outcome);
      if (outcome !== "retry") controller.setRetryReadConfirmed(false);
      controller.setProposal(null);
      controller.setIdempotencyKey(null);
      controller.setReviewError(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const detail = selected === null || read === null ? null : (
    <AmuxOwnerQueueDecision key={selected.taskId} item={selected} controller={reviewer}
      canInspectCards={canInspectCards} index={selectedIndex + 1} total={visible.length}
      generatedAt={read.generatedAt} navLocked={navLocked} advance={advance} onAdvanceChange={setAdvance}
      onPrevious={selectedIndex > 0 ? () => step(-1) : null}
      onNext={selectedIndex >= 0 && selectedIndex < visible.length - 1 ? () => step(1) : null}
      onAnswered={decided} canWriteEngineering={canWriteEngineering} onEngineeringChanged={refreshCard} />
  );

  return (
    <div className={focusMode ? "fixed inset-0 z-[60] overflow-auto bg-zinc-950 p-4 sm:p-6" : undefined}
      data-testid="amux-owner-queue-root" role="region" aria-label={copy.label}>
      <AmuxOwnerQueueView status={status} read={read} selectedId={selectedId} onSelect={select}
        navLocked={navLocked} query={query} onQuery={setQuery} groupFilter={groupFilter}
        onGroupFilter={setGroupFilter} focusMode={focusMode} onToggleFocus={() => setFocusMode((on) => !on)}
        onRetry={() => void load()} detail={detail} />
    </div>
  );
}
