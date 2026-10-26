"use client";

import { useEffect, useMemo, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { useQaReleaseTrainReads } from "@/components/admin/QaReleaseTrainRefresher";
import { announceQaReleaseTrainChanged, card } from "@/components/admin/qaReleaseTabParts";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { aestStamp } from "@/lib/agentOffice/time";
import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  qaReleaseTrainCargoPickable,
  type QaReleaseTrainCargoCandidate,
  type QaReleaseTrainCargoStatus,
  type QaReleaseTrainCarryReason,
  type QaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainCargoCore";
import type { QaReleaseTrainCargoCandidatesRead } from "@/lib/qaReleaseTrainCargoRead";
import { QA_RELEASE_TRAIN_DEFAULT_SLOTS } from "@/lib/qaReleaseTrainCore";
import type { QaReleaseTrainSchedule } from "@/lib/qaReleaseTrainStore";

const API = "/api/admin/agent-digests/qa-release/train-cargo";
const PAGE_PATH = "/admin/qa-release?tab=train";
const PR_URL = "https://github.com/mposition/Tomverse/pull/";

const BADGE: Record<QaReleaseTrainCargoStatus, string> = {
  available: "bg-emerald-400/15 text-emerald-300",
  unchecked: "bg-zinc-800 text-zinc-300",
  in_main_pull_request: "bg-zinc-800 text-zinc-400",
  on_main: "bg-zinc-800 text-zinc-400",
  mentioned: "bg-amber-300/15 text-amber-300",
  changes_workflows: "bg-amber-300/15 text-amber-300",
  back_merge: "bg-zinc-800 text-zinc-400",
};

type View = { candidates: QaReleaseTrainCargoCandidatesRead; selection: QaReleaseTrainSelection; schedule: (QaReleaseTrainSchedule & { nextDepartureAt: string | null }) | null };

const hoursText = (hours: readonly number[]) => hours.map((hour) => String(hour).padStart(2, "0")).join("·");

/**
 * The next release train's cargo (lib/qaReleaseTrainCargoCore.ts): merged
 * develop pull requests that are not yet on main, picked here and saved for
 * the next departure. Saving is owner or ops with a recent sign-in, audited;
 * the train reads the saved pick when it departs and spends it. What that
 * train left out rides the next one, marked here with the develop pull
 * requests a conflict needs first.
 */
/**
 * `reloadKey`: the overview's Refresh count. Each new value reads the
 * candidates again from GitHub, past the shared ten-minute read.
 */
export function QaReleaseTrainCargoSection({ canWrite, id, reloadKey = 0 }: { canWrite: boolean; id?: string; reloadKey?: number }) {
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
  // On the train tab its own "Read again" (and the emergency panel's save) read it again.
  const reads = useQaReleaseTrainReads();

  useEffect(() => {
    let cancelled = false;
    adminFetch(reloadKey > 0 || reads.fresh ? `${API}?fresh=1` : API, { cache: "no-store" })
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
  }, [reloadKey, reads.key, reads.fresh]);

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
      announceQaReleaseTrainChanged();
    } catch {
      setNotice({ tone: "error", text: m.trainCargoSaveFailed });
    } finally {
      setBusy(false);
    }
  };

  // What the last train left out, by number, and the develop pull requests a
  // conflict needs first that are not released yet (unlisted ones are older
  // than the window, or unknown, and are shown as such).
  const lastTrain = view?.selection.lastTrain ?? null;
  const carriedByNumber = new Map((lastTrain?.carried ?? []).map((carried) => [carried.number, carried]));
  const candidateByNumber = new Map(candidates.map((candidate) => [candidate.number, candidate]));
  const unreleased = (predecessors: readonly number[]) =>
    predecessors.filter((number) => {
      const status = candidateByNumber.get(number)?.status;
      return status === undefined || qaReleaseTrainCargoPickable(status) || status === "changes_workflows";
    });
  const trainLabel = lastTrain ? (lastTrain.pullRequestNumber !== null ? `#${lastTrain.pullRequestNumber}` : lastTrain.slot) : "";
  const leftOutText = (reason: QaReleaseTrainCarryReason) =>
    ({ conflict: m.trainCargoLeftOutConflict, over_capacity: m.trainCargoLeftOutFull, train_failed: m.trainCargoLeftOutFailed })[reason].replace(
      "{train}",
      trainLabel,
    );
  const pickAlso = (numbers: readonly number[]) =>
    setPicked((current) => {
      const next = new Set(current);
      for (const number of numbers) {
        const candidate = candidateByNumber.get(number);
        if (candidate && qaReleaseTrainCargoPickable(candidate.status) && next.size < QA_RELEASE_TRAIN_CARGO_MAX) next.add(number);
      }
      return next;
    });
  const carriedCount = view?.selection.departedWith && lastTrain?.slot === view.selection.departedWith ? view.selection.numbers.length : 0;

  const statusText = (candidate: QaReleaseTrainCargoCandidate) =>
    ({
      available: m.trainCargoAvailable,
      unchecked: m.trainCargoUnchecked,
      in_main_pull_request: m.trainCargoInMainPull.replace("{number}", String(candidate.mainPullRequest ?? "")),
      on_main: m.trainCargoOnMain.replace("{number}", String(candidate.mainPullRequest ?? "")),
      mentioned: m.trainCargoMentioned.replace("{number}", String(candidate.mainPullRequest ?? "")),
      changes_workflows: m.trainCargoWorkflows,
      back_merge: m.trainCargoBackMerge,
    })[candidate.status];

  const button =
    "inline-flex min-h-9 items-center justify-center rounded-lg border border-zinc-700 px-3 text-[13px] font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50";

  // The hours the train service said it runs on (QA_RELEASE_TRAIN_SLOTS), not
  // the default: the service reports them every round.
  const schedule = view?.schedule ?? null;
  const departures = schedule
    ? m.trainCargoSchedule
        .replace("{hours}", hoursText(schedule.hours))
        .replace("{next}", schedule.nextDepartureAt ? aestStamp(schedule.nextDepartureAt) : "-")
        .replace("{at}", aestStamp(schedule.reportedAt))
    : m.trainCargoScheduleUnknown.replace("{hours}", hoursText(QA_RELEASE_TRAIN_DEFAULT_SLOTS.split(",").map(Number)));

  return (
    <section className={card} id={id} data-testid="qa-release-train-cargo">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-zinc-100">{m.trainCargoTitle}</h3>
        <span className="text-xs text-zinc-400" data-testid="qa-release-train-schedule">
          {departures}
        </span>
        {view?.selection.savedAt ? (
          <span className="ml-auto text-xs text-zinc-500">
            {m.trainCargoLastSaved.replace("{at}", aestStamp(view.selection.savedAt)).replace("{by}", view.selection.savedBy ?? "-")}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-zinc-400">{m.trainCargoNote}</p>
      {view?.selection.departedWith ? (
        <p className="mt-2 text-[13px] text-zinc-400" data-testid="qa-release-train-cargo-departed">
          {carriedCount > 0
            ? m.trainCargoCarried.replace("{slot}", view.selection.departedWith).replace("{count}", String(carriedCount))
            : m.trainCargoDeparted.replace("{slot}", view.selection.departedWith)}
        </p>
      ) : null}

      {failed || view?.candidates.status === "unread" ? (
        <p className="mt-3 text-sm text-amber-300">
          {m.trainCargoUnread}
          {view?.candidates.status === "unread" ? m.githubFailure.replace("{failure}", view.candidates.failure) : ""}
        </p>
      ) : view === null ? (
        <p className="mt-3 text-sm text-zinc-400">{m.trainCargoLoading}</p>
      ) : (
        <>
          {view.candidates.status === "ok" && view.candidates.stale ? (
            // The newest read failed: the last good list stays, and says how old it is and why.
            <p className="mt-3 text-[13px] text-amber-300" data-testid="qa-release-train-cargo-stale">
              {m.trainCargoStale.replace("{at}", aestStamp(view.candidates.readAt)).replace("{failure}", view.candidates.stale.failure)}
            </p>
          ) : null}
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
                const carried = can ? carriedByNumber.get(candidate.number) : undefined;
                const needs = carried?.reason === "conflict" && carried.predecessors ? unreleased(carried.predecessors) : [];
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
                      {carried ? (
                        <div className="mt-1 text-xs text-amber-300" data-testid={`qa-release-train-cargo-carried-${candidate.number}`}>
                          <span>{leftOutText(carried.reason)}</span>
                          {carried.reason === "conflict" && carried.predecessors === null ? (
                            <span className="block text-zinc-400">{m.trainCargoPredecessorsUnknown}</span>
                          ) : carried.reason === "conflict" && needs.length === 0 ? (
                            <span className="block text-zinc-400">{m.trainCargoNoPredecessor}</span>
                          ) : null}
                          {needs.length > 0 ? (
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-zinc-300">
                              {m.trainCargoNeedsFirst}
                              {needs.map((number) => (
                                <a key={number} href={`${PR_URL}${number}`} target="_blank" rel="noreferrer" className="font-mono hover:underline">
                                  #{number}
                                  {candidateByNumber.has(number) ? "" : ` (${m.trainCargoOutsideList})`}
                                </a>
                              ))}
                              {canWrite && needs.some((number) => !picked.has(number) && candidateByNumber.has(number)) ? (
                                <button
                                  type="button"
                                  className="font-medium text-zinc-100 underline disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => pickAlso(needs)}
                                  data-testid={`qa-release-train-cargo-pick-needs-${candidate.number}`}
                                >
                                  {m.trainCargoPickPredecessors}
                                </button>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
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
