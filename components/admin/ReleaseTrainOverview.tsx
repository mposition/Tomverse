import Link from "next/link";
import { Check, GitPullRequest, Train } from "lucide-react";

import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { qaTrainNext, qaTrainRoute, qaTrainSlotHourToday, type TrainStopState } from "@/lib/adminAmuxFlow";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { formatAestClock } from "@/lib/adminUiCore";
import { readQaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesRead";
import { peekQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { QA_RELEASE_TRAIN_DEFAULT_SLOTS, parseQaReleaseTrainSlots } from "@/lib/qaReleaseTrainCore";
import {
  readQaReleaseTrainAdmissions,
  readQaReleaseTrainSchedule,
  readQaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainStore";

const PR_URL = "https://github.com/mposition/Tomverse/pull/";
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

const STOP_CLASS: Record<TrainStopState, string> = {
  departed: "bg-emerald-500 text-white",
  missed: "border-2 border-zinc-700 bg-zinc-900 text-zinc-500",
  next: "bg-blue-600 text-white ring-4 ring-blue-500/25",
  upcoming: "border-2 border-zinc-700 bg-zinc-900 text-zinc-500",
};

/**
 * The top of Release › QA: when the next train leaves and how long is left
 * (AEST), today's route, how production stands against main, and the pull
 * requests picked for the next train. Everything is read here, one read at a
 * time: a read that fails is named as unread, never drawn as nothing waiting,
 * and a train's departure is shown as having happened only when its admission
 * was recorded. The page's own merge lane and train views follow below. It
 * writes nothing; a train is merged by an operator with `npm run merge-train`.
 */
export async function ReleaseTrainOverview({ nowMs }: { nowMs: number }) {
  const m = (await getAdminMessages(adminAmuxScreensMessages)).release;
  const dayStart = Math.floor((nowMs + AEST_OFFSET_MS) / 86_400_000) * 86_400_000 - AEST_OFFSET_MS;
  const [scheduleRead, admissionsRead, selectionRead, mainRead] = await Promise.allSettled([
    readQaReleaseTrainSchedule(),
    readQaReleaseTrainAdmissions(new Date(dayStart)),
    readQaReleaseTrainSelection(),
    readQaReleaseMainCandidates(),
  ]);
  for (const [name, read] of [["schedule", scheduleRead], ["admissions", admissionsRead], ["selection", selectionRead], ["main", mainRead]] as const) {
    if (read.status === "rejected") console.warn(JSON.stringify({ event: "admin_release_overview_read_failed", read: name }));
  }

  // The hours the train service reported; before its first report, the policy's own default hours.
  const reported = scheduleRead.status === "fulfilled" ? scheduleRead.value : null;
  const hours = reported?.hours ?? parseQaReleaseTrainSlots(QA_RELEASE_TRAIN_DEFAULT_SLOTS) ?? [];
  const scheduleUnread = scheduleRead.status === "rejected";
  const admittedHours = admissionsRead.status === "fulfilled"
    ? new Set(admissionsRead.value.flatMap((admission) => qaTrainSlotHourToday(admission.slot, nowMs) ?? []))
    : null;
  const route = qaTrainRoute(nowMs, hours, admittedHours ?? new Set());
  const next = qaTrainNext(nowMs, hours);
  const selection = selectionRead.status === "fulfilled" ? selectionRead.value : null;
  const main = mainRead.status === "fulfilled" ? mainRead.value : null;
  const titles = new Map(
    (() => {
      const peek = peekQaReleaseTrainCargoCandidates();
      return peek?.status === "ok" ? peek.candidates.map((candidate) => [candidate.number, candidate.title] as const) : [];
    })(),
  );

  const remaining = next === null ? null : next.minutes >= 60 ? m.remaining(Math.floor(next.minutes / 60), next.minutes % 60) : m.remainingMinutes(next.minutes);
  const stopWord: Record<TrainStopState, string> = m.stops;
  const gap = main?.production.servesMainHead;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="release-train-overview">
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <AdminTile className="justify-between" data-testid="release-next-train">
          <div className="flex items-start gap-4">
            <AdminPixelAvatar team="qa" tile={64} unit={2} body={false} label={m.avatar} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-400">{m.next}</p>
              {next === null ? (
                <p className="text-xl font-bold text-zinc-300" data-testid="release-next-clock">{m.noSchedule}</p>
              ) : (
                <>
                  <p className="text-5xl font-bold tabular-nums tracking-tight text-white" data-testid="release-next-clock">
                    {formatAestClock(new Date(next.departsAtMs))}
                  </p>
                  <p className="mt-1 text-sm text-zinc-400" data-testid="release-next-remaining">{remaining}</p>
                </>
              )}
              {scheduleUnread ? <p className="mt-1 text-xs text-amber-300">{m.scheduleUnread}</p> : reported === null ? <p className="mt-1 text-xs text-zinc-500">{m.scheduleDefault}</p> : null}
            </div>
          </div>
          <p className="rounded-xl bg-zinc-950/60 px-4 py-3 text-sm text-zinc-300" data-testid="release-merge-train-note">{m.mergeTrainNote}</p>
        </AdminTile>

        <AdminTile title={m.routeTitle} description={admittedHours === null ? m.admissionsUnread : undefined} data-testid="release-route">
          <ol className="flex items-start justify-between gap-2" aria-label={m.routeTitle}>
            {route.map((stop) => (
              <li key={stop.hour} data-state={stop.state} className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
                <span aria-hidden="true" className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold ${STOP_CLASS[stop.state]}`}>
                  {stop.state === "departed" ? <Check className="h-4 w-4" strokeWidth={3} /> : stop.state === "next" ? <Train className="h-4 w-4" /> : null}
                </span>
                <span className="text-sm font-bold tabular-nums text-zinc-100">{String(stop.hour).padStart(2, "0")}:00</span>
                <span className={`text-xs ${stop.state === "next" ? "font-bold text-blue-300" : "text-zinc-500"}`}>{stopWord[stop.state]}</span>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 sm:grid-cols-3">
            <AdminKpiCard
              label={m.gap.label}
              value={main === null ? null : gap === null ? m.gap.unknown : gap ? m.gap.same : m.gap.behind}
              tone={gap === false ? "warn" : "neutral"}
              detail={main && gap === false ? `${short(main.production.servingSha) ?? "-"} → ${short(main.production.mainHeadSha) ?? "-"}` : undefined}
              className="p-4"
            />
            <AdminKpiCard
              label={m.riding.label}
              value={selection === null ? null : selection.numbers.length}
              detail={selection?.emergency.pending ? m.riding.emergency(selection.emergency.pending.numbers.length) : m.riding.detail}
              className="p-4"
            />
            <AdminKpiCard
              label={m.openMain.label}
              value={main === null || main.pullRequests === null ? null : main.pullRequests.length}
              detail={m.openMain.detail}
              className="p-4"
            />
          </div>
        </AdminTile>
      </div>

      <AdminTile
        title={next === null ? m.cargo.title : m.cargo.titleAt(formatAestClock(new Date(next.departsAtMs)))}
        description={m.cargo.lede}
        action={
          <Link
            href="/admin/release?tab=qa&view=train"
            className="inline-flex min-h-9 items-center rounded-xl border border-zinc-700 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
          >
            {m.cargo.pick}
          </Link>
        }
        data-testid="release-cargo"
      >
        {selection === null ? (
          <AdminStateBlock kind="error" title={m.cargo.unread} />
        ) : selection.numbers.length === 0 ? (
          <AdminStateBlock kind="empty" title={m.cargo.empty} detail={m.cargo.emptyDetail} />
        ) : (
          <ul className="flex flex-col gap-2">
            {selection.numbers.map((number) => (
              <li key={number} className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300">
                  <GitPullRequest className="h-4 w-4" aria-hidden />
                </span>
                <a
                  className="min-w-0 flex-1 truncate text-sm font-bold text-zinc-100 hover:underline"
                  href={`${PR_URL}${number}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="mr-2 font-mono text-xs font-normal text-zinc-500">#{number}</span>
                  {titles.get(number) ?? m.cargo.untitled}
                </a>
              </li>
            ))}
          </ul>
        )}
      </AdminTile>
    </div>
  );
}

/** What the overview shows while it reads: the tab has changed, and says so. */
export function ReleaseTrainOverviewLoading() {
  return <AdminStateBlock kind="loading" />;
}
