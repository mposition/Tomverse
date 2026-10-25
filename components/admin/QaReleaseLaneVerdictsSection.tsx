"use client";

import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { shouldIssueAdminPoll, type AdminPollTrigger } from "@/lib/adminPollTick";
import { card } from "@/components/admin/qaReleaseTabParts";
import { adminQaReleaseLaneMessages } from "@/lib/adminMessages/qaReleaseLane";
import { aestClock } from "@/lib/agentOffice/time";
import { qaReleaseLaneLiveVerdicts } from "@/lib/qaReleaseLaneLiveCore";
import type { QaReleaseLaneRoundVerdict, QaReleaseLaneRounds } from "@/lib/qaReleaseMergeLaneRoundStore";

const REPO = "https://github.com/mposition/Tomverse";
const REFRESH_MS = 20_000;

type LaneRead = { rounds: QaReleaseLaneRounds; github: { open: number[]; ciRunning: number[] } | null };

/**
 * The lane's record and what GitHub shows now -- the open pull requests and
 * those whose CI runs (/api/admin/qa-release/lane) -- read at once and every 20 seconds while the
 * page is visible, on the console's refresh and when the tab comes back.
 * Null until the first answer.
 */
function useLaneRead(): LaneRead | null {
  const [read, setRead] = useState<LaneRead | null>(null);
  useEffect(() => {
    let stopped = false;
    // One request at a time, none from a background tab's timer
    // (docs/ui-contracts/admin-console-ia.md rule 11).
    let inFlight = false;
    const poll = async (trigger: AdminPollTrigger) => {
      if (!shouldIssueAdminPoll({ inFlight, documentVisible: document.visibilityState === "visible", trigger })) return;
      inFlight = true;
      try {
        const response = await adminFetch("/api/admin/qa-release/lane", { cache: "no-store" });
        if (response.ok && !stopped) setRead((await response.json()) as LaneRead);
      } catch {
        // The next tick tries again; what is on screen stays.
      } finally {
        inFlight = false;
      }
    };
    const first = setTimeout(() => void poll("event"), 0);
    const timer = setInterval(() => void poll("interval"), REFRESH_MS);
    const onRefresh = () => void poll("event");
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll("event");
    };
    window.addEventListener("admin:refresh", onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("admin:refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return read;
}

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

type Tone = "idle" | "wait" | "merge" | "error";
const TONE: Record<string, Tone> = {
  merged: "merge",
  hold: "wait",
  waiting: "wait",
  attempt_in_flight: "wait",
  latched: "wait",
  state_unknown: "error",
  candidates_unknown: "error",
  report_not_recorded: "error",
};
const BAR: Record<Tone, string> = {
  idle: "bg-zinc-700",
  wait: "bg-amber-300",
  merge: "bg-emerald-400",
  error: "bg-rose-400",
};

/**
 * Admin › QA and release › Merge lane: what the lane did on its latest rounds
 * and what it thinks of every open develop pull request, so the operator sees
 * which ones are theirs without asking (owner, 2026-10-23). Read only; the
 * lane writes the record each round (lib/qaReleaseMergeLaneRoundStore.ts).
 */
export function QaReleaseLaneVerdictsSection({ rounds: initial, latched }: { rounds: QaReleaseLaneRounds; latched: boolean }) {
  const m = useAdminMessages(adminQaReleaseLaneMessages);
  const read = useLaneRead();
  const rounds = read?.rounds ?? initial;
  const latest = rounds.rounds[0] ?? null;
  // Between the lane's rounds: closed or merged pull requests leave, and
  // finished CI stops saying it runs (lib/qaReleaseLaneLiveCore.ts).
  const list = qaReleaseLaneLiveVerdicts(rounds.verdicts?.list ?? [], read?.github ?? null);
  const by = (status: QaReleaseLaneRoundVerdict["status"][]) => list.filter((v) => status.includes(v.status));
  const human = by(["human"]);
  const fix = by(["fix"]);
  const lane = by(["next", "queued"]);
  const waiting = by(["waiting"]);
  const drafts = by(["draft"]);

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="qa-release-lane-verdicts">
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section className={`${card} flex min-w-0 flex-col gap-2`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-100">{m.title}</h2>
            <span
              className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                latched ? "bg-amber-300/15 text-amber-300" : "bg-emerald-400/15 text-emerald-400"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${latched ? "bg-amber-300" : "bg-emerald-400"}`} aria-hidden="true" />
              {latched ? m.pillLatched : m.pillFree}
            </span>
          </div>
          {latest ? (
            <>
              <p className="text-sm text-zinc-100" data-testid="qa-release-lane-outcome">
                {m.outcome[latest.outcome] ?? latest.outcome}
              </p>
              <p className="text-xs text-zinc-500">
                {fill(m.lastRound, { at: aestClock(latest.at) })}
                {rounds.verdicts ? ` · ${fill(m.judgedAt, { at: aestClock(rounds.verdicts.at) })}` : ""}
              </p>
              <ol className="mt-2 flex items-end gap-1.5" aria-label={m.lastRound.replace("{at}", "")}>
                {[...rounds.rounds].reverse().map((round) => (
                  <li key={round.at} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${aestClock(round.at)} ${round.outcome}`}>
                    <span className={`block h-2 w-full rounded ${BAR[TONE[round.outcome] ?? "idle"]}`} />
                    <span className="text-[10px] text-zinc-500">{aestClock(round.at).slice(0, 5)}</span>
                  </li>
                ))}
              </ol>
              <p className="flex flex-wrap gap-3 text-[11px] text-zinc-500">
                {(["idle", "wait", "merge", "error"] as const).map((tone) => (
                  <span key={tone} className="inline-flex items-center gap-1">
                    <span className={`h-2 w-2 rounded-sm ${BAR[tone]}`} aria-hidden="true" />
                    {tone === "idle" ? m.legendIdle : tone === "wait" ? m.legendWait : tone === "merge" ? m.legendMerge : m.legendError}
                  </span>
                ))}
              </p>
            </>
          ) : (
            <p className="text-sm text-zinc-400">{m.noRounds}</p>
          )}
        </section>

        <section className={`${card} flex min-w-0 flex-col gap-3`}>
          <h2 className="text-base font-semibold text-zinc-100">{fill(m.openPulls, { count: list.length })}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Count label={m.countLane} value={lane.length} tone="text-emerald-400" />
            <Count label={m.countHuman} value={human.length} tone="text-amber-300" highlight={human.length > 0} />
            <Count label={m.countFix} value={fix.length} tone="text-rose-400" />
            <Count label={m.countWaiting} value={waiting.length} tone="text-zinc-300" />
            <Count label={m.countDraft} value={drafts.length} tone="text-zinc-400" />
          </div>
        </section>
      </div>

      {rounds.verdicts === null ? (
        <p className="text-sm text-zinc-400">{m.unjudged}</p>
      ) : (
        <>
          <Group title={m.groupHuman} why={m.groupHumanWhy} count={human.length} tone="amber" testId="qa-release-lane-human">
            {human.length === 0 ? <p className="text-sm text-zinc-400">{m.emptyHuman}</p> : human.map((v) => <Row key={v.number} verdict={v} human />)}
          </Group>
          {fix.length > 0 ? (
            <Group title={m.groupFix} why={m.groupFixWhy} count={fix.length} tone="rose" testId="qa-release-lane-fix">
              {fix.map((v) => (
                <Row key={v.number} verdict={v} />
              ))}
            </Group>
          ) : null}
          {lane.length > 0 ? (
            <Group title={m.groupLane} why={m.groupLaneWhy} count={lane.length} tone="emerald" testId="qa-release-lane-queue">
              {lane.map((v) => (
                <Row key={v.number} verdict={v} />
              ))}
            </Group>
          ) : null}
          {waiting.length > 0 ? (
            <Group title={m.groupWaiting} why={m.groupWaitingWhy} count={waiting.length} tone="zinc" testId="qa-release-lane-waiting">
              {waiting.map((v) => (
                <Row key={v.number} verdict={v} />
              ))}
            </Group>
          ) : null}
          {drafts.length > 0 ? (
            <details className={card} data-testid="qa-release-lane-drafts">
              <summary className="cursor-pointer text-sm text-zinc-300">
                <span className="font-semibold text-zinc-100">{m.groupDraft}</span> {drafts.length} · <span className="text-zinc-500">{m.groupDraftWhy}</span>
              </summary>
              <ul className="mt-3 flex flex-col gap-1 text-sm text-zinc-300">
                {drafts.map((v) => (
                  <li key={v.number} className="min-w-0 truncate">
                    <a className="hover:underline" href={`${REPO}/pull/${v.number}`} target="_blank" rel="noreferrer">
                      #{v.number}
                    </a>{" "}
                    {v.title}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function Count({ label, value, tone, highlight = false }: { label: string; value: number; tone: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${highlight ? "border-amber-300/60 bg-amber-300/10" : "border-zinc-800 bg-zinc-950/40"}`}>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );
}

const GROUP_TONE = {
  amber: "border-amber-300/40 bg-amber-300/[0.04]",
  rose: "",
  emerald: "",
  zinc: "",
} as const;
const CHIP_TONE = {
  amber: "bg-amber-300/15 text-amber-300",
  rose: "bg-rose-400/15 text-rose-400",
  emerald: "bg-emerald-400/15 text-emerald-400",
  zinc: "bg-zinc-800 text-zinc-300",
} as const;

function Group({
  title,
  why,
  count,
  tone,
  testId,
  children,
}: {
  title: string;
  why: string;
  count: number;
  tone: keyof typeof GROUP_TONE;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CHIP_TONE[tone]}`}>{count}</span>
        <span className="text-xs text-zinc-500">{why}</span>
      </div>
      <div className={`${card} flex min-w-0 flex-col divide-y divide-zinc-800 py-1 ${GROUP_TONE[tone]}`}>{children}</div>
    </section>
  );
}

function Row({ verdict, human = false }: { verdict: QaReleaseLaneRoundVerdict; human?: boolean }) {
  const m = useAdminMessages(adminQaReleaseLaneMessages);
  const href = `${REPO}/pull/${verdict.number}`;
  return (
    <div className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-2 py-3 sm:grid-cols-[3.5rem_1fr_auto]" data-testid={`qa-release-lane-pr-${verdict.number}`}>
      <a className="font-semibold text-zinc-400 hover:underline" href={href} target="_blank" rel="noreferrer">
        #{verdict.number}
      </a>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {verdict.status === "next" ? (
            <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">{m.next}</span>
          ) : verdict.status === "queued" ? (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">{m.queued}</span>
          ) : null}
          <span className="min-w-0 break-words font-medium text-zinc-100">{verdict.title || `#${verdict.number}`}</span>
        </div>
        <div className="mt-0.5 break-all font-mono text-xs text-zinc-500">{verdict.headRefName}</div>
        {verdict.reasons.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {verdict.reasons.map((reason) => (
              <span
                key={reason}
                className={`rounded-lg border px-2 py-0.5 text-xs ${
                  human ? "border-amber-300/50 text-amber-200" : verdict.status === "fix" ? "border-rose-400/50 text-rose-300" : "border-zinc-700 text-zinc-300"
                }`}
              >
                {m.reasons[reason] ?? reason}
              </span>
            ))}
            {verdict.failedChecks.map((check) => (
              <span key={check} className="rounded-lg border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
                {check}
              </span>
            ))}
          </div>
        ) : null}
        {verdict.files.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-0.5 rounded-lg border border-dashed border-zinc-700 bg-zinc-950/50 px-3 py-2 font-mono text-xs text-zinc-300">
            {verdict.files.map((file) => (
              <li key={file.path} className="break-all">
                <span className="text-amber-300">{file.path}</span>{" "}
                <span className="text-zinc-500">· {file.reasons.map((reason) => m.reasons[reason] ?? reason).join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="col-span-2 flex flex-col items-start gap-1 sm:col-span-1 sm:items-end">
        <a
          className={`rounded-lg border px-3 py-1.5 text-sm ${
            human ? "border-zinc-100 bg-zinc-100 font-semibold text-zinc-900" : "border-zinc-700 text-zinc-100 hover:bg-zinc-800"
          }`}
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {human ? m.mergeOnGithub : m.openOnGithub} ↗
        </a>
        {human ? <span className="text-[11px] text-zinc-500">{m.mergeCommitHint}</span> : null}
      </div>
    </div>
  );
}
