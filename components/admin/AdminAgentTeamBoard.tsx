"use client";

import Link from "next/link";
import { ArrowRight, Clock, Inbox } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminRing } from "@/components/admin/ui/AdminCharts";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import {
  teamBoardCards,
  teamBoardTotals,
  teamBoardUsd,
  type TeamBoardCard,
  type TeamBoardExtras,
} from "@/lib/adminAgentTeamBoardCore";
import { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import type { AgentOfficeLiveRooms } from "@/lib/agentOffice/live";
import { formatAestClock, formatAestDateTime } from "@/lib/adminUiCore";

const WORK_QUEUE_AGENTS_HREF = "/admin/work-queue?tab=agents";

/**
 * Agents home › Team board: three totals and one card per AI team.
 *
 * Every figure is the office's own read of the team (`AgentOfficeLiveRooms`),
 * so the board and the live office cannot disagree. It writes nothing and
 * calls no team. A team that could not be read is a dashed "unavailable" card,
 * and a total that depends on it says it is a floor.
 */
export function AdminAgentTeamBoard({
  rooms,
  extras,
  readAt,
}: {
  /** Null when the office's read could not run at all. */
  rooms: AgentOfficeLiveRooms | null;
  extras: TeamBoardExtras;
  readAt: string;
}) {
  const m = useAdminMessages(adminAgentPageMessages);
  const ui = useAdminMessages(adminUiMessages);
  const board = m.board;
  if (rooms === null) {
    return (
      <div data-testid="team-board" className="flex min-w-0 flex-col gap-5">
        <AdminStateBlock kind="error" title={ui.unavailable} detail={ui.unreadDetail} />
      </div>
    );
  }
  const cards = teamBoardCards(rooms, extras, board, m.status);
  const totals = teamBoardTotals(cards);
  const cost = totals.cost;
  const fraction = cost && cost.capMicroUsd ? Math.min(1, cost.spentMicroUsd / cost.capMicroUsd) : null;
  const ringColor = fraction === null ? "blue" : fraction >= 0.9 ? "red" : fraction >= 0.7 ? "amber" : "emerald";
  const clock = formatAestClock(new Date(readAt));

  return (
    <div data-testid="team-board" className="flex min-w-0 flex-col gap-5">
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <AdminTile data-testid="team-board-waiting">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300">
                <Inbox className="h-6 w-6" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-400">{board.waitingTitle}</p>
                <p className="text-3xl font-bold tabular-nums tracking-tight text-white">
                  {board.waitingDetail(totals.waiting)}
                  {totals.waitingFloor ? <span aria-hidden> +?</span> : null}
                </p>
              </div>
            </div>
            <Link
              href={WORK_QUEUE_AGENTS_HREF}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-bold text-white hover:bg-blue-500"
            >
              {board.openInbox}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          {totals.waitingFloor ? <p className="text-xs text-amber-300">{board.waitingFloor}</p> : null}
        </AdminTile>

        <AdminTile data-testid="team-board-cost">
          <div className="flex items-center gap-4">
            {fraction !== null ? (
              <AdminRing fraction={fraction} size={72} stroke={9} color={ringColor} label={board.costTitle}>
                <span className="text-sm font-bold tabular-nums text-white">{Math.round(fraction * 100)}%</span>
              </AdminRing>
            ) : null}
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-400">{board.costTitle}</p>
              {cost ? (
                <>
                  <p className="text-3xl font-bold tabular-nums tracking-tight text-white">
                    {teamBoardUsd(cost.spentMicroUsd)}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {cost.capMicroUsd !== null
                      ? board.costDetail(teamBoardUsd(cost.capMicroUsd), cost.teams)
                      : board.costCapNone}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-zinc-400">{board.costNone}</p>
              )}
            </div>
          </div>
        </AdminTile>

        <AdminTile data-testid="team-board-working">
          <div className="flex items-center justify-between gap-3">
            <div className="flex -space-x-1" aria-hidden>
              {cards.map((card) => (
                <span key={card.key} className={card.running === "running" ? "" : "opacity-40"}>
                  <AdminPixelAvatar team={card.avatar} unit={2} body={false} tile={32} />
                </span>
              ))}
            </div>
            <div className="min-w-0 text-right">
              <p className="text-sm font-medium text-zinc-400">{board.workingTitle}</p>
              <p className="text-3xl font-bold tabular-nums tracking-tight text-white">
                {board.workingOf(totals.running, totals.total)}
                {totals.runningFloor ? <span aria-hidden> +?</span> : null}
              </p>
            </div>
          </div>
          {totals.runningFloor ? <p className="text-xs text-amber-300">{board.workingFloor}</p> : null}
        </AdminTile>
      </div>

      <ul className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map((card) => (
          <li key={card.key} className="min-w-0">
            <TeamCard card={card} />
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500">{board.readAt(clock)}</p>
    </div>
  );
}

function TeamCard({ card }: { card: TeamBoardCard }) {
  const m = useAdminMessages(adminAgentPageMessages);
  const board = m.board;
  const unknown = card.tone === "unknown";
  const fraction =
    card.cost.kind === "known" && card.cost.capMicroUsd
      ? Math.min(1, card.cost.spentMicroUsd / card.cost.capMicroUsd)
      : null;
  const when = (iso: string | null) => formatAestDateTime(iso);
  const time = card.nextAt !== null ? board.nextAt(when(card.nextAt) ?? "") : null;
  const last = card.lastAt !== null ? board.last(when(card.lastAt) ?? "") : board.lastNone;
  return (
    <Link
      href={card.href}
      data-testid="team-board-card"
      data-team={card.key}
      data-tone={card.tone}
      aria-label={board.openTeam(card.name)}
      className={`group flex h-full min-w-0 flex-col gap-3 rounded-2xl border p-4 transition hover:bg-zinc-800/60 ${
        unknown ? "border-dashed border-zinc-700 bg-transparent" : "border-zinc-800 bg-zinc-900"
      } ${card.dim ? "opacity-70" : ""}`}
    >
      <div className="relative flex h-28 items-center justify-center rounded-xl bg-zinc-800/50">
        <AdminPixelAvatar team={card.avatar} unit={4} />
        {card.waiting !== null && card.waiting > 0 ? (
          <span
            data-testid="team-board-waiting-count"
            className="absolute right-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-bold text-white"
            title={board.waiting(card.waiting)}
          >
            {card.waiting}
          </span>
        ) : null}
        {card.waitingUnread ? (
          <span
            title={board.waitingFloor}
            className="absolute right-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-dashed border-amber-400 px-1.5 text-xs font-bold text-amber-300"
          >
            ?
          </span>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="truncate text-base font-bold text-white">{card.name}</p>
        <div className="mt-1.5">
          <AdminStatusChip tone={card.tone}>{card.statusLabel}</AdminStatusChip>
        </div>
      </div>
      <p className="min-h-10 text-sm leading-5 text-zinc-300">{card.activity}</p>
      <div className="mt-auto flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          <span>{board.thisMonth}</span>
          <span className="tabular-nums text-zinc-200">
            {card.cost.kind === "known"
              ? card.cost.capMicroUsd
                ? `${teamBoardUsd(card.cost.spentMicroUsd)} / ${Math.round(card.cost.capMicroUsd / 1_000_000)}`
                : teamBoardUsd(card.cost.spentMicroUsd)
              : card.cost.kind === "unknown"
                ? board.costUnknown
                : board.noCost}
          </span>
        </div>
        {fraction !== null ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
            <div
              className={`h-full rounded-full ${fraction >= 0.9 ? "bg-red-500" : fraction >= 0.7 ? "bg-amber-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
            />
          </div>
        ) : null}
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{time ?? last}</span>
        </p>
      </div>
    </Link>
  );
}
