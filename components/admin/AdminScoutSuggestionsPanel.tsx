"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  CHIP,
  NEUTRAL_CHIP,
  SEVERITY_CHIP,
  SEVERITY_RANK,
  STATE_CHIP,
  fill,
  localTime,
  nextScoutSendBatch,
  runScoutSuggestionBatch,
  scoutState,
} from "@/lib/adminScoutDisplay";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { formatAestDate, formatAestDateTime } from "@/lib/adminUiCore";
import { adminFetch } from "@/lib/adminFetch";
import { AdminCopyWorkBriefButton } from "@/components/admin/AdminCopyWorkBriefButton";
import { ScoutMemoryComparison } from "./ScoutMemoryComparison";
import { ScoutAgentAside } from "@/components/admin/ScoutAgentAside";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import type { ScoutDaySummary } from "@/lib/productResearchScoutCore";
import type { ScoutConsoleSuggestion, ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";
import { suggestionWorkBrief } from "@/lib/productResearchScoutIdeaText";
import { SUPPORTED_LANGUAGES as MEMORY_PROBE_LOCALES } from "@/lib/language";
import { scoutSubjectInfo } from "@/lib/productResearchScoutSubjects";

/**
 * The Scout's open suggestions (docs/policy/product-research-agent.md §10),
 * laid out for one decision each: complete it, drop it or send it to AMUX.
 *
 * The top row answers "is it working and what is waiting" at a glance. The
 * list is grouped by the page or file a suggestion is about, the groups that
 * hold a high-severity suggestion open first, and suggestions can be selected
 * and handled together. Everything shown is stored text the model wrote;
 * React escapes it.
 */
const RETURN_TO = "/admin/product-research?tab=suggestions";

type Action = "dismiss" | "send" | "complete";

type RowState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly action: Action }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly failure: AdminApiFailure };

type Bulk =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly action: Action; readonly done: number; readonly total: number }
  | { readonly kind: "finished"; readonly done: number; readonly total: number; readonly failure: AdminApiFailure | null };

const BUTTON =
  "inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border px-3.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 sm:flex-none";
const DISMISS_BUTTON = `${BUTTON} border-zinc-700 text-zinc-300 hover:bg-zinc-800 sm:border-transparent`;
const SEND_BUTTON = `${BUTTON} border-blue-800 text-blue-300 hover:bg-blue-950`;
const COMPLETE_BUTTON = `${BUTTON} border-emerald-800 text-emerald-300 hover:bg-emerald-950`;
const COPY_BUTTON = `${BUTTON} border-zinc-700 text-zinc-200 hover:bg-zinc-800`;

/**
 * The text "Send to AMUX" would send (the same suggestionIdeaText), plus the page
 * and when it is done, for pasting into a local CLI. In Korean, as the AMUX idea is.
 */
export function scoutSuggestionBrief(suggestion: ScoutConsoleSuggestion, origin: string): string {
  const info = scoutSubjectInfo(suggestion.subject);
  const labels = adminProductResearchScoutMessages.ko;
  return suggestionWorkBrief(
    { ...suggestion, url: info.kind === "page" ? `${origin}${info.href}` : null },
    { url: labels.briefUrl, done: labels.briefDone },
  );
}
const SEGMENT =
  "min-h-9 px-3 text-xs font-medium text-zinc-400 hover:text-zinc-100 aria-pressed:bg-zinc-800 aria-pressed:font-semibold aria-pressed:text-zinc-50";

export function AdminScoutSuggestionsPanel({
  initial,
  week,
}: {
  initial: ScoutConsoleView;
  /**
   * The last seven days for the side tiles (newest first), or null when they
   * could not be read. Left out, the side tiles are not drawn at all.
   */
  week?: readonly ScoutDaySummary[] | null;
}) {
  const m = useAdminMessages(adminProductResearchScoutMessages);
  const { locale } = useAdminLocale();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [severity, setSeverity] = useState<string>("all");
  const [memoryOnly, setMemoryOnly] = useState(false);
  const memoryQuality = initial.memoryQuality;
  const [areas, setAreas] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<"subject" | "newest">("subject");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<Bulk>({ kind: "idle" });

  const state = scoutState(initial);
  const subjectLabel = (subject: string) => {
    const info = scoutSubjectInfo(subject);
    if (info.kind === "page") {
      const page = m.pages[info.page as keyof typeof m.pages] ?? info.page;
      const lang = m.languages[info.lang as keyof typeof m.languages] ?? info.lang;
      return `${page} · ${lang}`;
    }
    if (info.kind === "memory") return m.memoryLabel + " · " + (m.languages[info.lang as keyof typeof m.languages] ?? info.lang);
    if (info.kind === "file") return m.files[info.format as keyof typeof m.files] ?? subject;
    if (info.kind === "catalogue") return m.catalogue;
    if (info.kind === "issue") return fill(m.issue, { number: info.number });
    return subject;
  };
  const severityLabel = (value: string) => m.severity[value as keyof typeof m.severity] ?? value;
  const areaLabel = (value: string) => m.area[value as keyof typeof m.area] ?? value;

  // Suggestions handled on this screen stay in place, marked, until the next load.
  const pending = initial.open.filter((row) => rows[row.id]?.kind !== "done");
  const bySeverity = (value: string) => pending.filter((row) => row.severity === value).length;
  const areaCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of initial.open) counts.set(row.area, (counts.get(row.area) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [initial.open]);

  const visible = initial.open.filter(
    (row) => (!memoryOnly || scoutSubjectInfo(row.subject).kind === "memory") && (severity === "all" || row.severity === severity) && (areas.size === 0 || areas.has(row.area)),
  );
  const groups = useMemo(() => {
    const bySubject = new Map<string, ScoutConsoleSuggestion[]>();
    for (const row of initial.open) bySubject.set(row.subject, [...(bySubject.get(row.subject) ?? []), row]);
    const top = (list: readonly ScoutConsoleSuggestion[]) => Math.min(...list.map((row) => SEVERITY_RANK[row.severity] ?? 3));
    return [...bySubject.entries()]
      .map(([subject, list]) => ({
        subject,
        list: [...list].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)),
        top: top(list),
      }))
      .sort((a, b) => a.top - b.top || b.list.length - a.list.length || a.subject.localeCompare(b.subject));
  }, [initial.open]);
  const visibleIds = new Set(visible.map((row) => row.id));
  const isOpen = (subject: string, top: number) => expanded[subject] ?? top === 0;

  const act = async (suggestion: ScoutConsoleSuggestion, action: Action): Promise<AdminApiFailure | null> => {
    setRows((current) => ({ ...current, [suggestion.id]: { kind: "busy", action } }));
    let response: Response;
    try {
      response = await adminFetch(`/api/admin/product-research/suggestions/${encodeURIComponent(suggestion.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The server derives the AMUX request id from the suggestion, so a resend is the same request.
        body: JSON.stringify({ action }),
      });
    } catch {
      const failure = adminNetworkFailure(locale);
      setRows((current) => ({ ...current, [suggestion.id]: { kind: "failed", failure } }));
      return failure;
    }
    if (!response.ok) {
      const failure = await readAdminApiFailure(response, { fallback: m.failed, locale });
      setRows((current) => ({ ...current, [suggestion.id]: { kind: "failed", failure } }));
      return failure;
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string; amuxIdeaId?: string | null };
    if (body.status !== "completed" && body.status !== "sent" && body.status !== "dismissed" && body.status !== "unchanged") {
      const failure: AdminApiFailure = { message: m.failed, tone: "error", requiresReauthentication: false, approvalId: null };
      setRows((current) => ({ ...current, [suggestion.id]: { kind: "failed", failure } }));
      return failure;
    }
    const message = body.status === "unchanged" ? m.unchanged : body.status === "completed" ? m.completed
      : body.status === "sent" ? fill(m.sent, { ideaId: body.amuxIdeaId ?? "-" }) : m.dismissed;
    setRows((current) => ({ ...current, [suggestion.id]: { kind: "done", message } }));
    setSelected((current) => {
      const next = new Set(current);
      next.delete(suggestion.id);
      return next;
    });
    return null;
  };

  const runBulk = async (action: Action) => {
    const queue = initial.open.filter((row) => selected.has(row.id) && rows[row.id]?.kind !== "done");
    setBulk({ kind: "running", action, done: 0, total: queue.length });
    const result = await runScoutSuggestionBatch(queue, action, (row) => act(row, action),
      (done) => setBulk({ kind: "running", action, done, total: queue.length }));
    setBulk({ kind: "finished", ...result });
  };

  const toggle = (ids: readonly string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const selectable = (row: ScoutConsoleSuggestion) => rows[row.id]?.kind !== "done" && (initial.canDismiss || initial.canSend || initial.canComplete);
  const batch = nextScoutSendBatch(visible.filter(selectable));

  const renderRow = (suggestion: ScoutConsoleSuggestion, showSubject: boolean) => {
    const row = rows[suggestion.id] ?? { kind: "idle" as const };
    const busy = row.kind === "busy" || bulk.kind === "running";
    const done = row.kind === "done";
    return (
      <li
        key={suggestion.id}
        className={`flex gap-3 border-t border-zinc-800 px-4 py-3.5 ${done ? "opacity-60" : ""}`}
        data-testid="admin-product-research-scout-suggestion"
      >
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-blue-600"
          aria-label={fill(m.selectRow, { title: suggestion.title })}
          checked={selected.has(suggestion.id)}
          disabled={!selectable(suggestion) || busy}
          onChange={(event) => toggle([suggestion.id], event.target.checked)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <AdminStatusChip tone={suggestion.severity === "high" ? "bad" : suggestion.severity === "medium" ? "warn" : "idle"}>{severityLabel(suggestion.severity)}</AdminStatusChip>
              <span className={`${CHIP} ${NEUTRAL_CHIP}`}>{areaLabel(suggestion.area)}</span>
              {showSubject ? <span className="text-xs text-zinc-400">{subjectLabel(suggestion.subject)}</span> : null}
              <span className="font-mono text-xs text-zinc-500">
                <time dateTime={suggestion.createdAt} suppressHydrationWarning>{localTime(suggestion.createdAt, locale, { today: m.todayWord, tomorrow: m.tomorrowWord })}</time>
              </span>
            </div>
            <h4 className="mt-1.5 text-sm font-semibold text-zinc-50">{suggestion.title}</h4>
            <p className="mt-1 text-sm text-zinc-400">{suggestion.suggestion}</p>
            {suggestion.agentWork ? (
              <p className="mt-2 text-xs text-zinc-300" data-testid="scout-agent-work">
                {m.agentWork[suggestion.agentWork.status]}
                {suggestion.agentWork.reason ? ` · ${suggestion.agentWork.reason}` : null}
                {suggestion.agentWork.prUrl ? (
                  <> · <a className="text-blue-300 hover:text-blue-200" href={suggestion.agentWork.prUrl} target="_blank" rel="noreferrer">{suggestion.agentWork.prUrl}</a></>
                ) : null}
              </p>
            ) : null}
            <details className="mt-1.5">
              <summary className="w-fit cursor-pointer text-xs font-medium text-blue-300 hover:text-blue-200">{m.evidenceShow}</summary>
              <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
                <p className="text-[11px] font-medium text-zinc-500">{m.evidenceLabel}</p>
                <p className="mt-1 text-sm text-zinc-300">{suggestion.evidence}</p>
              </div>
            </details>
            {done ? (
              <p className="mt-2 text-sm text-zinc-300" role="status">
                {row.message}
              </p>
            ) : null}
            {row.kind === "failed" ? (
              <AdminApiFailureNotice failure={row.failure} returnTo={RETURN_TO} testId="admin-product-research-scout-failure" />
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            {done ? null : (
              <>
                <button
                  type="button"
                  className={COMPLETE_BUTTON}
                  disabled={busy || !initial.canComplete}
                  title={initial.canComplete ? m.completeHint : m.completeNotAllowed}
                  onClick={() => act(suggestion, "complete")}
                >
                  {row.kind === "busy" && row.action === "complete" ? m.completing : m.complete}
                </button>
                <button
                  type="button"
                  className={DISMISS_BUTTON}
                  disabled={busy || !initial.canDismiss}
                  title={initial.canDismiss ? undefined : m.dismissNotAllowed}
                  onClick={() => act(suggestion, "dismiss")}
                >
                  {row.kind === "busy" && row.action === "dismiss" ? m.dismissing : m.dismiss}
                </button>
                <button
                  type="button"
                  className={SEND_BUTTON}
                  disabled={busy || !initial.canSend}
                  title={initial.canSend ? undefined : m.sendNotAllowed}
                  onClick={() => act(suggestion, "send")}
                >
                  {row.kind === "busy" && row.action === "send" ? m.sending : m.send}
                </button>
              </>
            )}
            <AdminCopyWorkBriefButton
              brief={() => scoutSuggestionBrief(suggestion, window.location.origin)}
              labels={{ copy: m.copyBrief, copied: m.briefCopied, failed: m.briefCopyFailed }}
              className={COPY_BUTTON}
              testId="admin-product-research-scout-copy-brief"
            />
          </div>
        </div>
      </li>
    );
  };

  const selectedCount = [...selected].filter((id) => rows[id]?.kind !== "done").length;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="admin-product-research-scout">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${CHIP} ${STATE_CHIP[state]}`} data-testid="admin-product-research-scout-state">
          {state === "on" ? m.stateOn : state === "judging_off" ? m.stateJudgingOff : m.stateOff}
        </span>
        <p className="min-w-0 flex-1 text-sm text-zinc-400">{m.intro}</p>
      </div>

      {initial.memoryComparison && <ScoutMemoryComparison comparison={initial.memoryComparison} />}
      {memoryQuality && (
        <section className="rounded-xl border border-zinc-800 p-4" data-testid="memory-quality-coverage">
          <h3 className="font-semibold">{m.memoryTitle}</h3>
          <p className="mt-1 text-sm text-zinc-400">{m.memoryDesc}</p>
          <p className="mt-2 text-sm">
            {!memoryQuality.enabled && m.memoryOff + " "}
            {fill(m.memoryDays, {
              count: memoryQuality.readings.filter((r) => formatAestDate(r.measuredAt) === memoryQuality.day).length,
              day: memoryQuality.day,
            })}
          </p>
          <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {MEMORY_PROBE_LOCALES.map((lang) => {
              const reading = memoryQuality.readings.find((r) => r.locale === lang);
              return (
                <li key={lang} className="rounded-lg bg-zinc-900 p-2">
                  <strong>{m.languages[lang]}</strong>{" · "}
                  {formatAestDate(reading?.measuredAt) !== memoryQuality.day && <span>{m.memoryWaiting}{reading && " · "}</span>}
                  {reading && <span>{formatAestDateTime(reading.measuredAt)} · {m.memoryModes[reading.mode]} · {m.memoryStatus[reading.outcome]} · {reading.model}</span>}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            aria-pressed={memoryOnly}
            disabled={bulk.kind === "running"}
            className="mt-3 min-h-9 text-sm font-semibold text-blue-300 underline"
            onClick={() => {
              setMemoryOnly(!memoryOnly);
              setSelected(new Set());
              setAreas(new Set());
              setSeverity("all");
            }}
          >
            {m.memoryFilter}
          </button>
        </section>
      )}
      {state === "on" ? null : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <span className="min-w-0 flex-1">
            {state === "off" ? m.disabled : !initial.settings.modelId ? m.modelOff : m.capZero}
          </span>
          {state === "off" ? null : (
            <Link href="/admin/product-research?tab=runs" className="font-semibold underline underline-offset-2">
              {m.goToSettings}
            </Link>
          )}
        </div>
      )}

      <div className={week === undefined ? "contents" : "grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]"}>
      <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border border-zinc-700" role="group" aria-label={m.severityFilter}>
            {(["all", "high", "medium", "low"] as const).map((value, index) => (
              <button
                key={value}
                type="button"
                aria-pressed={severity === value}
                className={`${SEGMENT} ${index > 0 ? "border-l border-zinc-700" : ""}`}
                onClick={() => setSeverity(value)}
              >
                {value === "all" ? `${m.all} ${pending.length}` : `${severityLabel(value)} ${bySeverity(value)}`}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={m.areaFilter}>
            {areaCounts.map(([area, count]) => (
              <button
                key={area}
                type="button"
                aria-pressed={areas.has(area)}
                className={`${CHIP} min-h-7 ${NEUTRAL_CHIP} hover:border-zinc-500 aria-pressed:border-blue-500 aria-pressed:bg-blue-500/15 aria-pressed:text-blue-200`}
                onClick={() =>
                  setAreas((current) => {
                    const next = new Set(current);
                    if (next.has(area)) next.delete(area);
                    else next.add(area);
                    return next;
                  })
                }
              >
                {areaLabel(area)} {count}
              </button>
            ))}
            {memoryOnly || severity !== "all" || areas.size > 0 ? (
              <button
                type="button"
                className="min-h-7 px-1 text-xs font-medium text-blue-300 hover:text-blue-200"
                onClick={() => {
                  setMemoryOnly(false);
                  setSeverity("all");
                  setAreas(new Set());
                }}
              >
                {m.clearFilters}
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {initial.canSend && batch.length > 0 ? (
            <button
              type="button"
              className="min-h-9 px-2 text-xs font-medium text-blue-300 hover:text-blue-200 disabled:opacity-50"
              data-testid="admin-product-research-scout-select-batch"
              disabled={bulk.kind === "running"}
              onClick={() => {
                setSelected(new Set(batch));
                setBulk({ kind: "idle" });
              }}
            >
              {fill(m.selectBatch, { count: batch.length })}
            </button>
          ) : null}
          {view === "subject" ? (
            <button
              type="button"
              className="min-h-9 px-2 text-xs font-medium text-zinc-400 hover:text-zinc-100"
              onClick={() => {
                const anyClosed = groups.some((group) => !isOpen(group.subject, group.top));
                setExpanded(Object.fromEntries(groups.map((group) => [group.subject, anyClosed])));
              }}
            >
              {groups.some((group) => !isOpen(group.subject, group.top)) ? m.expandAll : m.collapseAll}
            </button>
          ) : null}
          <span className="text-xs text-zinc-500">{m.groupBy}</span>
          <div className="flex overflow-hidden rounded-lg border border-zinc-700" role="group" aria-label={m.groupBy}>
            <button type="button" aria-pressed={view === "subject"} className={SEGMENT} onClick={() => setView("subject")}>
              {m.bySubject}
            </button>
            <button type="button" aria-pressed={view === "newest"} className={`${SEGMENT} border-l border-zinc-700`} onClick={() => setView("newest")}>
              {m.newest}
            </button>
          </div>
        </div>
      </div>

      {!initial.canSend ? <p className="text-xs text-zinc-400">{initial.canDismiss ? m.sendNotAllowed : m.dismissNotAllowed}</p> : null}

      {initial.open.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-sm text-zinc-400">{m.empty}</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-sm text-zinc-400">{m.emptyFiltered}</p>
      ) : view === "newest" ? (
        <ul className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 [&>li:first-child]:border-t-0">
          {[...visible].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((row) => renderRow(row, true))}
        </ul>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => {
            const shown = group.list.filter((row) => visibleIds.has(row.id));
            if (shown.length === 0) return null;
            const open = isOpen(group.subject, group.top);
            const info = scoutSubjectInfo(group.subject);
            const ids = shown.filter(selectable).map((row) => row.id);
            const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
            const topSeverity = group.list[0].severity;
            return (
              <section
                key={group.subject}
                className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
                data-testid="admin-product-research-scout-group"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-blue-600"
                    aria-label={`${m.selectGroup}: ${subjectLabel(group.subject)}`}
                    checked={allSelected}
                    disabled={ids.length === 0 || bulk.kind === "running"}
                    onChange={(event) => toggle(ids, event.target.checked)}
                  />
                  <button
                    type="button"
                    aria-expanded={open}
                    className="flex min-h-9 min-w-0 items-center gap-2 text-left"
                    onClick={() => setExpanded((current) => ({ ...current, [group.subject]: !open }))}
                  >
                    <span aria-hidden className="w-3 text-zinc-400">
                      {open ? "▾" : "▸"}
                    </span>
                    <h3 className="text-[15px] font-bold text-zinc-50">{subjectLabel(group.subject)}</h3>
                  </button>
                  {info.kind === "page" ? (
                    <a
                      href={info.href}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-blue-300 hover:text-blue-200"
                      aria-label={`${m.openPage}: ${info.path}`}
                    >
                      {info.path} ↗
                    </a>
                  ) : info.kind === "issue" ? (
                    <a
                      href={info.href}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-blue-300 hover:text-blue-200"
                      aria-label={`${m.openIssue}: #${info.number}`}
                    >
                      #{info.number} ↗
                    </a>
                  ) : null}
                  <span className={`${CHIP} ${NEUTRAL_CHIP}`}>{fill(m.groupCount, { count: shown.length })}</span>
                  {topSeverity === "high" ? <span className={`${CHIP} ${SEVERITY_CHIP.high}`}>{m.groupHasHigh}</span> : null}
                  {!open ? <span className={`${CHIP} ${SEVERITY_CHIP[topSeverity] ?? NEUTRAL_CHIP}`}>{severityLabel(topSeverity)}</span> : null}
                </div>
                {open ? <ul>{shown.map((row) => renderRow(row, false))}</ul> : null}
              </section>
            );
          })}
        </div>
      )}

      <p className="text-xs text-zinc-500">
        {initial.counts.open > initial.open.length
          ? fill(m.shownLimited, { shown: initial.open.length, total: initial.counts.open, dismissed: initial.counts.dismissed, sent: initial.counts.sent })
          : fill(m.shownAll, { count: initial.open.length, dismissed: initial.counts.dismissed, sent: initial.counts.sent })}
      </p>

      <details className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3" data-testid="admin-product-research-scout-completed">
        <summary className="cursor-pointer text-sm font-medium text-zinc-200">{fill(m.completedHeading, { count: initial.counts.completed })}</summary>
        <p className="mt-2 text-xs text-zinc-400">{fill(m.completedShowing, { shown: initial.completed.length, total: initial.counts.completed })}</p>
        <ul className="mt-2 divide-y divide-zinc-800">
          {initial.completed.map((row) => (
            <li key={row.id} className="py-2 text-sm text-zinc-300">
              <p>{row.title}</p>
              <p className="text-xs text-zinc-400">{subjectLabel(row.subject)}{row.completedAt ? <> · <time dateTime={row.completedAt} suppressHydrationWarning>{localTime(row.completedAt, locale, { today: m.todayWord, tomorrow: m.tomorrowWord })}</time></> : null}</p>
            </li>
          ))}
        </ul>
      </details>

      {selectedCount > 0 || bulk.kind !== "idle" ? (
        <div
          className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-blue-500/60 bg-zinc-900 px-4 py-3 shadow-lg sm:flex-row sm:items-center"
          data-testid="admin-product-research-scout-bulk"
        >
          <div className="min-w-0 flex-1" role="status">
            {bulk.kind === "running" ? (
              <>
                <p className="text-sm font-semibold text-zinc-50">{fill(m.bulkProgress, { done: bulk.done, total: bulk.total })}</p>
                {bulk.action === "send" ? <p className="text-xs text-zinc-400">{m.bulkSendNote}</p> : null}
              </>
            ) : (
              <>
                {selectedCount > 0 ? <p className="text-sm font-semibold text-zinc-50">{fill(m.selected, { count: selectedCount })}</p> : null}
                {bulk.kind === "finished" ? (
                  <p className="text-xs text-zinc-400">
                    {bulk.failure ? fill(m.bulkStopped, { done: bulk.done, total: bulk.total }) : fill(m.bulkDone, { done: bulk.done, total: bulk.total })}
                  </p>
                ) : null}
              </>
            )}
            {bulk.kind === "finished" && bulk.failure ? (
              <AdminApiFailureNotice failure={bulk.failure} returnTo={RETURN_TO} testId="admin-product-research-scout-bulk-failure" />
            ) : null}
          </div>
          {selectedCount > 0 ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-11 px-3 text-sm font-medium text-zinc-400 hover:text-zinc-100 disabled:opacity-50 sm:min-h-9"
                disabled={bulk.kind === "running"}
                onClick={() => {
                  setSelected(new Set());
                  setBulk({ kind: "idle" });
                }}
              >
                {m.clearSelection}
              </button>
              <button
                type="button"
                className={COMPLETE_BUTTON}
                disabled={bulk.kind === "running" || !initial.canComplete}
                title={initial.canComplete ? m.completeHint : m.completeNotAllowed}
                onClick={() => runBulk("complete")}
              >
                {fill(m.bulkComplete, { count: selectedCount })}
              </button>
              <button
                type="button"
                className={`${BUTTON} border-zinc-700 text-zinc-200 hover:bg-zinc-800`}
                disabled={bulk.kind === "running" || !initial.canDismiss}
                onClick={() => runBulk("dismiss")}
              >
                {fill(m.bulkDismiss, { count: selectedCount })}
              </button>
              <button
                type="button"
                className={`${BUTTON} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                disabled={bulk.kind === "running" || !initial.canSend}
                onClick={() => runBulk("send")}
              >
                {fill(m.bulkSend, { count: selectedCount })}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="min-h-11 px-3 text-sm font-medium text-zinc-400 hover:text-zinc-100 sm:min-h-9"
              onClick={() => setBulk({ kind: "idle" })}
            >
              {m.clearSelection}
            </button>
          )}
        </div>
      ) : null}
      </div>
      {week === undefined ? null : <ScoutAgentAside initial={initial} week={week} />}
      </div>
    </div>
  );
}
