"use client";

import { Fragment, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { aestStamp } from "@/lib/agentOffice/time";
import { adminQaReleaseTrainMessages } from "@/lib/adminMessages/qaReleaseTrain";
import { qaReleaseTrainBoardDays, type QaReleaseTrainBoardRow, type QaReleaseTrainBoardStatus } from "@/lib/qaReleaseTrainBoardCore";

const PR_URL = "https://github.com/mposition/Tomverse/pull/";
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;

// A departure board stays dark in both console themes: fixed colours, which
// the Light theme's palette remap (admin-theme.css) does not touch.
const STATUS_STYLE: Record<QaReleaseTrainBoardStatus, string> = {
  running: "bg-[#13314f] text-[#9cc6f0]",
  boarding: "bg-[#4a3510] text-[#fac775]",
  unknown: "bg-[#3a3936] text-[#c9c7bd]",
  arrived: "bg-[#24361a] text-[#a8d672]",
  cancelled: "bg-[#3a3936] text-[#c9c7bd]",
  empty: "bg-[#3a3936] text-[#c9c7bd]",
  failed: "bg-[#4b1d1d] text-[#f4a3a3]",
  unreported: "bg-[#4b1d1d] text-[#f4a3a3]",
};
const EMERGENCY_STYLE = "bg-[#4a2214] text-[#f5b39b]";
const GRID = "grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[4rem_9.5rem_minmax(0,1fr)_5.5rem_6.5rem]";

const aestClock = (iso: string) => new Date(Date.parse(iso) + AEST_OFFSET_MS).toISOString().slice(11, 16);
const aestDay = (iso: string) => new Date(Date.parse(iso) + AEST_OFFSET_MS).toISOString().slice(5, 10);

/** One split-flap character: it riffles through digits once when the board mounts, then holds. */
function Flap({ char, delay }: { char: string; delay: number }) {
  const [shown, setShown] = useState(char);
  useEffect(() => {
    if (!/[0-9]/.test(char) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 6 + delay) {
        window.clearInterval(timer);
        setShown(char);
      } else setShown(String(Math.floor(Math.random() * 10)));
    }, 55);
    return () => window.clearInterval(timer);
  }, [char, delay]);
  return (
    <span className="relative inline-block min-w-[0.8rem] rounded-[3px] bg-[#2f2f2c] text-center font-mono text-[15px] leading-6 text-[#f5c46b] after:absolute after:inset-x-0 after:top-1/2 after:border-t after:border-[#1c1c1a]">
      {shown}
    </span>
  );
}

/**
 * The release train tab's departure board (lib/qaReleaseTrainBoardCore.ts):
 * the last seven AEST days, one day at a time, newest train first, each row opening to what rode, what was left out and
 * why, and where its main pull request stands.
 */
export function QaReleaseTrainBoard({ rows, pullsRead, nowMs }: { rows: QaReleaseTrainBoardRow[]; pullsRead: boolean; nowMs: number }) {
  const m = useAdminMessages(adminQaReleaseTrainMessages);
  const [open, setOpen] = useState<string | null>(null);
  const days = qaReleaseTrainBoardDays(rows, nowMs);
  // The newest day that had a train, so an empty morning does not hide yesterday.
  const [dayIndex, setDayIndex] = useState(() => Math.max(0, days.findIndex((day) => day.rows.length > 0)));
  const selected = days[dayIndex];
  const weekdays = m.boardWeekdays.split(",");
  const [clock, setClock] = useState(nowMs);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const status = (s: QaReleaseTrainBoardStatus) =>
    ({
      running: m.statusRunning,
      unreported: m.statusUnreported,
      boarding: m.statusBoarding,
      unknown: m.statusUnknown,
      arrived: m.statusArrived,
      cancelled: m.statusCancelled,
      empty: m.statusEmpty,
      failed: m.statusFailed,
    })[s];
  const duration = (fromIso: string, toIso: string) => {
    const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
    if (minutes < 60) return m.durationMinutes.replace("{m}", String(minutes));
    if (minutes < 24 * 60) return m.durationHours.replace("{h}", String(Math.floor(minutes / 60))).replace("{m}", String(minutes % 60));
    return m.durationDays.replace("{d}", String(Math.floor(minutes / 1440))).replace("{h}", String(Math.floor((minutes % 1440) / 60)));
  };
  const reason = (row: QaReleaseTrainBoardRow["leftOut"][number]) => {
    if (row.outcome === "over_capacity") return m.detailOverCapacity;
    if (row.outcome === "changes_workflows") return m.detailWorkflows;
    const needs =
      row.predecessors === null
        ? m.detailNeedsUnknown
        : row.predecessors.length === 0
          ? m.detailNeedsNone
          : m.detailNeeds.replace("{numbers}", row.predecessors.map((n) => `#${n}`).join(" "));
    return `${m.detailConflict} · ${needs}`;
  };
  const pullLink = (number: number, title: string) => (
    <>
      <a className="font-mono text-[#f5c46b] hover:underline" href={`${PR_URL}${number}`} target="_blank" rel="noreferrer">
        #{number}
      </a>{" "}
      {title}
    </>
  );

  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="qa-release-train-board">
      <div className="rounded-2xl bg-[#1c1c1a] p-3 sm:p-4">
        <div className="mb-3 flex items-baseline justify-between px-2">
          <h2 className="font-mono text-base tracking-[0.2em] text-[#f5c46b]">{m.boardTitle.toUpperCase()}</h2>
          <span className="font-mono text-xs text-[#8a8984]">{aestClock(new Date(clock).toISOString())} AEST</span>
        </div>
        <div className="mb-3 flex items-center gap-1.5 px-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 font-mono text-sm text-[#f5c46b] hover:bg-[#2a2a27] disabled:text-[#4a4945] disabled:hover:bg-transparent"
            aria-label={m.boardPrevDay}
            disabled={dayIndex === days.length - 1}
            onClick={() => setDayIndex(dayIndex + 1)}
            data-testid="qa-release-train-board-prev-day"
          >
            ‹
          </button>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto" role="group" aria-label={m.boardDays}>
            {days.map((day, index) => {
              const current = index === dayIndex;
              const weekday = weekdays[day.weekday] ?? "";
              return (
                <button
                  key={day.day}
                  type="button"
                  className={`flex min-w-[3.5rem] shrink-0 flex-col items-center rounded-md px-2 py-1 font-mono text-[11px] leading-4 ${
                    current ? "bg-[#f5c46b] text-[#1c1c1a]" : "bg-[#2a2a27] text-[#d6d4cb] hover:bg-[#34342f] disabled:bg-transparent disabled:text-[#4a4945]"
                  }`}
                  aria-pressed={current}
                  aria-label={m.boardDayChip.replace("{day}", day.day.slice(5)).replace("{weekday}", weekday).replace("{count}", String(day.rows.length))}
                  disabled={day.rows.length === 0 && !current}
                  onClick={() => setDayIndex(index)}
                  data-testid={`qa-release-train-board-day-${day.day}`}
                >
                  <span aria-hidden="true">{day.day.slice(5)}</span>
                  <span aria-hidden="true">
                    {weekday} · {day.rows.length}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="rounded-md px-2 py-1 font-mono text-sm text-[#f5c46b] hover:bg-[#2a2a27] disabled:text-[#4a4945] disabled:hover:bg-transparent"
            aria-label={m.boardNextDay}
            disabled={dayIndex === 0}
            onClick={() => setDayIndex(dayIndex - 1)}
            data-testid="qa-release-train-board-next-day"
          >
            ›
          </button>
        </div>
        {rows.length > 0 ? (
          <p className="mb-2 px-2 font-mono text-[11px] text-[#a3a29b]" data-testid="qa-release-train-board-day-summary">
            {m.boardDaySummary
              .replace("{day}", `${selected.day.slice(5)} ${weekdays[selected.weekday] ?? ""}`)
              .replace("{trains}", String(selected.rows.length))
              .replace("{rode}", String(selected.rows.reduce((sum, row) => sum + row.included.length, 0)))
              .replace("{left}", String(selected.rows.reduce((sum, row) => sum + row.leftOut.length, 0)))
              .replace("{arrived}", String(selected.rows.filter((row) => row.status === "arrived").length))}
          </p>
        ) : null}
        <div className={`${GRID} px-2 pb-1 font-mono text-[11px] text-[#8a8984]`}>
          <span>{m.boardTime}</span>
          <span>{m.boardTrain}</span>
          <span className="hidden sm:block">{m.boardLoad}</span>
          <span className="hidden sm:block">{m.boardPull}</span>
          <span className="text-right sm:text-left">{m.boardStatus}</span>
        </div>
        {selected.rows.length === 0 ? (
          <p className="px-2 py-4 text-sm text-[#c9c7bd]">{rows.length === 0 ? m.boardEmpty : m.boardDayEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {selected.rows.map((row, index) => {
              const key = row.slot;
              const expanded = open === key;
              return (
                <Fragment key={key}>
                  <li>
                    <button
                      type="button"
                      className={`${GRID} w-full rounded-lg px-2 py-2 text-left hover:bg-[#2a2a27] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#f5c46b]`}
                      aria-expanded={expanded}
                      // The flap digits are hidden from assistive technology: the name carries all a row shows.
                      aria-label={m.boardRowLabel
                        .replace("{slot}", row.slot)
                        .replace("{time}", aestClock(row.admittedAt))
                        .replace("{status}", status(row.status))
                        .replace("{rode}", String(row.included.length))
                        .replace("{left}", String(row.leftOut.length))
                        .replace("{pull}", row.pullRequestNumber !== null ? `#${row.pullRequestNumber}` : "—")}
                      onClick={() => setOpen(expanded ? null : key)}
                      data-testid={`qa-release-train-board-row-${row.slot}`}
                    >
                      <span className="flex gap-0.5" aria-hidden="true">
                        {[...aestClock(row.admittedAt)].map((char, at) =>
                          char === ":" ? (
                            <span key={at} className="font-mono text-[#f5c46b]">
                              :
                            </span>
                          ) : (
                            <Flap key={at} char={char} delay={(index * 2 + at) % 7} />
                          ),
                        )}
                      </span>
                      <span className="min-w-0 font-mono text-[13px] text-[#d6d4cb]">
                        <span className="block truncate">{row.slot}</span>
                        <span className="flex items-center gap-2 text-[11px] text-[#8a8984]">
                          {aestDay(row.admittedAt)}
                          {row.emergency ? <span className={`rounded px-1.5 ${EMERGENCY_STYLE}`}>{m.emergencyBadge}</span> : null}
                          <span className="sm:hidden">
                            ▲{row.included.length} ▼{row.leftOut.length}
                          </span>
                        </span>
                      </span>
                      <span className="hidden font-mono text-[13px] sm:block">
                        <span className="text-[#a8d672]">▲ {row.included.length}</span>
                        <span className={`ml-3 ${row.leftOut.length > 0 ? "text-[#f0997b]" : "text-[#6f6e69]"}`}>▼ {row.leftOut.length}</span>
                      </span>
                      <span className="hidden font-mono text-[13px] text-[#d6d4cb] sm:block">{row.pullRequestNumber !== null ? `#${row.pullRequestNumber}` : "—"}</span>
                      <span className={`justify-self-end rounded px-2 py-0.5 text-center text-xs font-medium sm:justify-self-stretch ${STATUS_STYLE[row.status]}`}>
                        {status(row.status)}
                      </span>
                    </button>
                  </li>
                  {expanded ? (
                    <li className="mx-1 mb-2 rounded-lg bg-[#2a2a27] px-3 py-3 text-[13px] text-[#d6d4cb]" data-testid={`qa-release-train-board-detail-${row.slot}`}>
                      <p className="text-xs text-[#a3a29b]">
                        {m.detailDeparted.replace("{at}", aestStamp(row.admittedAt))}
                        {row.settledAt
                          ? ` · ${m.detailSettled
                              .replace("{state}", row.status === "arrived" ? m.detailMerged : m.detailClosed)
                              .replace("{at}", aestStamp(row.settledAt))
                              .replace("{duration}", duration(row.admittedAt, row.settledAt))}`
                          : ""}
                        {row.rcSha ? ` · ${m.detailRc.replace("{sha}", row.rcSha.slice(0, 9))}` : ""}
                      </p>
                      {row.status === "running" ? <p className="mt-2">{m.detailRunning}</p> : null}
                      {row.status === "unreported" ? <p className="mt-2 text-[#f4a3a3]">{m.detailUnreported}</p> : null}
                      {row.failure ? <p className="mt-2 text-[#f4a3a3]">{m.detailFailure.replace("{failure}", row.failure)}</p> : null}
                      {row.included.length > 0 ? (
                        <>
                          <h3 className="mt-3 text-xs font-medium text-[#f5c46b]">{m.detailRode.replace("{count}", String(row.included.length))}</h3>
                          <ul className="mt-1 flex flex-col gap-0.5">
                            {row.included.map((pull) => (
                              <li key={pull.number}>{pullLink(pull.number, pull.title)}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {row.leftOut.length > 0 ? (
                        <>
                          <h3 className="mt-3 text-xs font-medium text-[#f5c46b]">{m.detailLeftOut.replace("{count}", String(row.leftOut.length))}</h3>
                          <ul className="mt-1 flex flex-col gap-1">
                            {row.leftOut.map((pull) => (
                              <li key={pull.number}>
                                {pullLink(pull.number, pull.title)}
                                <span className="block text-xs text-[#f0997b]">{reason(pull)}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {row.alreadyOnMain.length > 0 ? (
                        <p className="mt-3 text-xs text-[#a3a29b]">{m.detailAlready.replace("{numbers}", row.alreadyOnMain.map((n) => `#${n}`).join(" "))}</p>
                      ) : null}
                      {row.onOpenTrain.length > 0 ? (
                        <p className="mt-1 text-xs text-[#a3a29b]">{m.detailOnOpenTrain.replace("{numbers}", row.onOpenTrain.map((n) => `#${n}`).join(" "))}</p>
                      ) : null}
                      {row.pullRequestNumber !== null ? (
                        <a
                          className="mt-3 inline-flex min-h-8 items-center rounded-md bg-[#1c1c1a] px-3 text-xs font-medium text-[#f5c46b] hover:underline"
                          href={`${PR_URL}${row.pullRequestNumber}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {m.detailOpenPull.replace("{number}", String(row.pullRequestNumber))}
                        </a>
                      ) : null}
                    </li>
                  ) : null}
                </Fragment>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        {(
          [
            ["boarding", m.legendBoarding],
            ["arrived", m.legendArrived],
            ["empty", m.legendEmpty],
            ["failed", m.legendFailed],
          ] as const
        ).map(([s, label]) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 ${STATUS_STYLE[s]}`}>{status(s)}</span>
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 ${EMERGENCY_STYLE}`}>{m.emergencyBadge}</span>
          {m.legendEmergency}
        </span>
      </div>
      <p className="text-xs text-zinc-500">{m.boardWeekNote}</p>
      {pullsRead ? null : <p className="text-xs text-amber-300">{m.boardPullsUnread}</p>}
    </section>
  );
}
