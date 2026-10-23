"use client";

import { useEffect, useMemo, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { card } from "@/components/admin/qaReleaseTabParts";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { aestStamp } from "@/lib/agentOffice/time";
import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  qaReleaseTrainCargoPickable,
  type QaReleaseTrainCargoCandidate,
  type QaReleaseTrainCargoStatus,
  type QaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainCargoCore";
import type { QaReleaseTrainCargoCandidatesRead } from "@/lib/qaReleaseTrainCargoRead";

const API = "/api/admin/agent-digests/qa-release/train-cargo";
const PAGE_PATH = "/admin/qa-release";
const PR_URL = "https://github.com/mposition/Tomverse/pull/";

const BADGE: Record<QaReleaseTrainCargoStatus, string> = {
  available: "bg-emerald-400/15 text-emerald-300",
  unchecked: "bg-zinc-800 text-zinc-300",
  in_main_pull_request: "bg-zinc-800 text-zinc-400",
  on_main: "bg-zinc-800 text-zinc-400",
  changes_workflows: "bg-amber-300/15 text-amber-300",
  back_merge: "bg-zinc-800 text-zinc-400",
};

type View = { candidates: QaReleaseTrainCargoCandidatesRead; selection: QaReleaseTrainSelection };

/**
 * The next release train's cargo (lib/qaReleaseTrainCargoCore.ts): merged
 * develop pull requests that are not yet on main, picked here and saved for
 * the next departure. Saving is owner or ops with a recent sign-in, audited;
 * the train reads the saved pick when it departs and spends it.
 */
export function QaReleaseTrainCargoSection({ canWrite, id }: { canWrite: boolean; id?: string }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [query, setQuery] = useState("");
  // What cannot ride is counted, not listed, unless asked for (owner, 2026-10-23: the list ran to hundreds).
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    adminFetch(API, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<View>;
      })
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setPicked(new Set(next.selection.numbers));
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saved = useMemo(() => new Set(view?.selection.numbers ?? []), [view]);
  const changed = picked.size !== saved.size || [...picked].some((number) => !saved.has(number));
  const candidates = view?.candidates.status === "ok" ? view.candidates.candidates : [];
  const pickable = candidates.filter((candidate) => qaReleaseTrainCargoPickable(candidate.status));
  const shown = candidates.filter(
    (candidate) =>
      (showAll || qaReleaseTrainCargoPickable(candidate.status)) &&
      (query.trim() === "" || `#${candidate.number} ${candidate.title}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const hiddenByStatus = new Map<QaReleaseTrainCargoStatus, number>();
  for (const candidate of candidates) {
    if (!qaReleaseTrainCargoPickable(candidate.status)) hiddenByStatus.set(candidate.status, (hiddenByStatus.get(candidate.status) ?? 0) + 1);
  }

  // "Select all" covers what can ride among the rows shown, so a search narrows it.
  const shownPickable = shown.filter((candidate) => qaReleaseTrainCargoPickable(candidate.status)).map((candidate) => candidate.number);
  const allShownPicked = shownPickable.length > 0 && shownPickable.every((number) => picked.has(number));
  const someShownPicked = shownPickable.some((number) => picked.has(number));
  const toggleAll = () =>
    setPicked((current) => {
      const next = new Set(current);
      if (allShownPicked) for (const number of shownPickable) next.delete(number);
      else for (const number of shownPickable) if (next.size < QA_RELEASE_TRAIN_CARGO_MAX) next.add(number);
      return next;
    });

  const toggle = (number: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else if (next.size < QA_RELEASE_TRAIN_CARGO_MAX) next.add(number);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      // Only what can still ride: a pick saved earlier may have reached main since.
      const numbers = pickable.filter((candidate) => picked.has(candidate.number)).map((candidate) => candidate.number);
      const response = await adminFetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numbers }),
      });
      const payload = (await response.json().catch(() => ({}))) as { code?: unknown; result?: QaReleaseTrainSelection };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (!response.ok || !payload.result) {
        setNotice({ tone: "error", text: m.trainCargoSaveFailed });
        return;
      }
      setView((current) => (current ? { ...current, selection: payload.result! } : current));
      setPicked(new Set(payload.result.numbers));
      setNotice({ tone: "ok", text: m.trainCargoSaved.replace("{count}", String(payload.result.numbers.length)) });
    } catch {
      setNotice({ tone: "error", text: m.trainCargoSaveFailed });
    } finally {
      setBusy(false);
    }
  };

  const statusText = (candidate: QaReleaseTrainCargoCandidate) =>
    ({
      available: m.trainCargoAvailable,
      unchecked: m.trainCargoUnchecked,
      in_main_pull_request: m.trainCargoInMainPull.replace("{number}", String(candidate.mainPullRequest ?? "")),
      on_main: m.trainCargoOnMain.replace("{number}", String(candidate.mainPullRequest ?? "")),
      changes_workflows: m.trainCargoWorkflows,
      back_merge: m.trainCargoBackMerge,
    })[candidate.status];

  const button =
    "inline-flex min-h-9 items-center justify-center rounded-lg border border-zinc-700 px-3 text-[13px] font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50";

  return (
    <section className={card} id={id} data-testid="qa-release-train-cargo">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-zinc-100">{m.trainCargoTitle}</h3>
        <span className="text-xs text-zinc-400">{m.trainCargoDepartures}</span>
        {view?.selection.savedAt ? (
          <span className="ml-auto text-xs text-zinc-500">
            {m.trainCargoLastSaved.replace("{at}", aestStamp(view.selection.savedAt)).replace("{by}", view.selection.savedBy ?? "-")}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-zinc-400">{m.trainCargoNote}</p>
      {view?.selection.departedWith ? (
        <p className="mt-2 text-[13px] text-zinc-400">{m.trainCargoDeparted.replace("{slot}", view.selection.departedWith)}</p>
      ) : null}

      {failed || view?.candidates.status === "unread" ? (
        <p className="mt-3 text-sm text-amber-300">{m.trainCargoUnread}</p>
      ) : view === null ? (
        <p className="mt-3 text-sm text-zinc-400">{m.trainCargoLoading}</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              [m.trainCargoCanRide, pickable.length],
              [m.trainCargoPicked, pickable.filter((candidate) => picked.has(candidate.number)).length],
              [m.trainCargoCannotRide, candidates.length - pickable.length],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-zinc-950 px-3 py-2">
                <div className="text-xs text-zinc-400">{label}</div>
                <div className="font-mono text-lg font-semibold text-zinc-100">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={m.trainCargoSearch}
              aria-label={m.trainCargoSearch}
              className="min-h-9 min-w-[12rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"
            />
            <label className={`${button} cursor-pointer gap-2`} data-testid="qa-release-train-cargo-select-all">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={allShownPicked}
                ref={(element) => {
                  if (element) element.indeterminate = someShownPicked && !allShownPicked;
                }}
                disabled={!canWrite || busy || shownPickable.length === 0}
                onChange={toggleAll}
              />
              {m.trainCargoPickAll}
            </label>
            <button type="button" className={button} disabled={!canWrite || busy} onClick={() => setPicked(new Set())}>
              {m.trainCargoClear}
            </button>
          </div>

          {hiddenByStatus.size > 0 ? (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-zinc-400" data-testid="qa-release-train-cargo-hidden">
              {m.trainCargoHiddenSummary.replace(
                "{list}",
                (
                  [
                    ["on_main", m.trainCargoHiddenOnMain],
                    ["in_main_pull_request", m.trainCargoHiddenInMainPull],
                    ["changes_workflows", m.trainCargoHiddenWorkflows],
                    ["back_merge", m.trainCargoHiddenBackMerge],
                  ] as const
                )
                  .filter(([status]) => hiddenByStatus.has(status))
                  .map(([status, label]) => `${label} ${hiddenByStatus.get(status)}`)
                  .join(" · "),
              )}
              <button type="button" className="font-medium text-zinc-200 underline" onClick={() => setShowAll((value) => !value)}>
                {showAll ? m.trainCargoHideHidden : m.trainCargoShowHidden}
              </button>
            </p>
          ) : null}

          {shown.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">{m.trainCargoEmpty}</p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-800 rounded-lg border border-zinc-800" data-testid="qa-release-train-cargo-list">
              {shown.map((candidate) => {
                const can = qaReleaseTrainCargoPickable(candidate.status);
                return (
                  <li
                    key={candidate.number}
                    className={`flex items-center gap-3 px-3 py-2.5 ${can ? "" : "opacity-55"}`}
                    data-testid={`qa-release-train-cargo-${candidate.number}`}
                  >
                    <input
                      type="checkbox"
                      className={`h-4 w-4 shrink-0 ${can ? "" : "cursor-not-allowed"}`}
                      checked={can && picked.has(candidate.number)}
                      disabled={!canWrite || busy || !can}
                      onChange={() => toggle(candidate.number)}
                      aria-label={m.trainCargoPickLabel.replace("{number}", String(candidate.number))}
                    />
                    <a
                      href={`${PR_URL}${candidate.number}`}
                      target="_blank"
                      rel="noreferrer"
                      className="w-14 shrink-0 font-mono text-[13px] text-zinc-300 hover:underline"
                    >
                      #{candidate.number}
                    </a>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-zinc-100">{candidate.title}</div>
                      <div className="text-xs text-zinc-500">
                        {m.trainCargoMerged.replace("{at}", aestStamp(candidate.mergedAt)).replace("{by}", candidate.author || "-")}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[candidate.status]}`}>{statusText(candidate)}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {reauthenticationRequired ? (
            <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-amber-300">
              {m.trainCargoReauth}
              <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
                {m.signInAgain}
              </a>
            </p>
          ) : null}
          {notice ? (
            <p role="status" className={`mt-3 text-sm ${notice.tone === "ok" ? "text-emerald-300" : "text-amber-300"}`}>
              {notice.text}
            </p>
          ) : null}

          {canWrite ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-zinc-400">{changed ? m.trainCargoUnsaved : m.trainCargoSavedState}</span>
              <button type="button" className={`${button} ml-auto`} disabled={busy || !changed} onClick={() => setPicked(new Set(saved))}>
                {m.trainCargoReset}
              </button>
              <button
                type="button"
                className="inline-flex min-h-9 items-center justify-center rounded-lg bg-blue-500 px-4 text-[13px] font-semibold text-white hover:bg-blue-400 disabled:opacity-50"
                disabled={busy || !changed}
                onClick={() => void save()}
                data-testid="qa-release-train-cargo-save"
              >
                {m.trainCargoSave}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
