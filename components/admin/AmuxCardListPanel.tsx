"use client";

import { useState } from "react";
import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { AmuxAdminCardRow, AmuxAdminHierarchyNode } from "@/lib/amux/adminCardList";
import { projectAmuxAdminHierarchy } from "@/lib/amux/adminHierarchyCore";
import { AMUX_ADMIN_KANBAN_LANES, projectAmuxAdminKanban,
  type AmuxAdminKanbanLane } from "@/lib/amux/adminKanbanCore";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";

const cellClass = "border-b border-zinc-200 px-2 py-1 align-top dark:border-zinc-700";

export function AmuxCardListPanel({
  rows,
  hierarchyNodes,
  total,
  limit,
  nextCursor,
}: {
  rows: AmuxAdminCardRow[];
  hierarchyNodes: AmuxAdminHierarchyNode[];
  total: number;
  limit: number;
  nextCursor: string | null;
}) {
  const messages = useAdminMessages(adminAmuxCardsMessages);
  const [view, setView] = useState<"board" | "list" | "hierarchy">("board");
  const board = projectAmuxAdminKanban(rows);
  const hierarchy = projectAmuxAdminHierarchy(rows, hierarchyNodes);
  const laneTitles: Record<AmuxAdminKanbanLane, string> = {
    tomverse_backlog: messages.laneTomverseBacklog,
    amux_backlog: messages.laneAmuxBacklog,
    todo: messages.laneTodo,
    in_progress: messages.laneInProgress,
    in_review: messages.laneInReview,
    owner_attention: messages.laneOwnerAttention,
  };
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-card-list-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-card-list-count">
        {messages.shown(rows.length, total, limit)}
      </p>
      <div role="group" aria-label={messages.viewLabel} className="flex gap-2">
        <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}
          className="rounded border border-zinc-400 px-3 py-1 text-sm aria-pressed:bg-zinc-800 aria-pressed:text-white dark:aria-pressed:bg-zinc-200 dark:aria-pressed:text-zinc-900">
          {messages.viewBoard}
        </button>
        <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}
          className="rounded border border-zinc-400 px-3 py-1 text-sm aria-pressed:bg-zinc-800 aria-pressed:text-white dark:aria-pressed:bg-zinc-200 dark:aria-pressed:text-zinc-900">
          {messages.viewList}
        </button>
        <button type="button" aria-pressed={view === "hierarchy"} onClick={() => setView("hierarchy")}
          className="rounded border border-zinc-400 px-3 py-1 text-sm aria-pressed:bg-zinc-800 aria-pressed:text-white dark:aria-pressed:bg-zinc-200 dark:aria-pressed:text-zinc-900">
          {messages.viewHierarchy}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.empty}</p>
      ) : view === "board" ? (
        <>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {messages.boardScope(rows.length, total, nextCursor !== null)}
          </p>
          {board.terminalCount > 0 ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {messages.terminalInList(board.terminalCount)}
            </p>
          ) : null}
          <div className="flex gap-3 overflow-x-auto pb-3" data-testid="amux-kanban-board">
            {AMUX_ADMIN_KANBAN_LANES.map((lane) => (
              <section key={lane} aria-label={laneTitles[lane]}
                className="w-56 shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-900">
                <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {laneTitles[lane]} <span className="font-normal">({board.lanes[lane].length})</span>
                </h3>
                <div className="space-y-2">
                  {board.lanes[lane].map((row) => (
                    <article key={row.id} data-testid="amux-kanban-card"
                      className="rounded border border-zinc-200 bg-white p-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                      <h4 className="break-words font-medium">{row.sourceKey ?? row.id}</h4>
                      {row.sourceKey ? <p className="break-all font-mono text-zinc-500 dark:text-zinc-400">{row.id}</p> : null}
                      <p>{row.status} · {row.kind} · {row.priority}</p>
                      <p>{messages.columnOwner}: {row.owner ?? messages.none}</p>
                      {row.status === "todo" && row.owner !== null && !row.claimVerified
                        ? <p className="text-amber-700 dark:text-amber-300">{messages.assignmentUnverified}</p> : null}
                      {row.hasOwnerAttentionEscalation
                        ? <p className="text-amber-700 dark:text-amber-300">{messages.escalationOpen}</p> : null}
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : view === "hierarchy" ? (
        <div className="space-y-2" data-testid="amux-hierarchy-list">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {messages.hierarchyScope(rows.length, total)}
          </p>
          <ol className="space-y-1">
            {hierarchy.map((item) => <li key={`${item.kind}:${item.id}`}
              className="rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
              style={{ marginInlineStart: `${item.depth * 1.25}rem` }}>
              <span className="font-medium">
                {item.kind === "unlinked" ? messages.hierarchyUnlinked :
                  item.kind === "outside_page_story" ? messages.hierarchyOutsideStory(item.id) :
                    item.label}
              </span>
              {item.status ? <span className="ms-2 text-zinc-600 dark:text-zinc-400">
                {item.status}
              </span> : null}
            </li>)}
          </ol>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-800 dark:text-zinc-100">
            <thead>
              <tr>
                <th scope="col" className={cellClass}>{messages.columnCard}</th>
                <th scope="col" className={cellClass}>{messages.columnStatus}</th>
                <th scope="col" className={cellClass}>{messages.columnOwner}</th>
                <th scope="col" className={cellClass}>{messages.columnPriority}</th>
                <th scope="col" className={cellClass}>{messages.columnKind}</th>
                <th scope="col" className={cellClass}>{messages.columnBrief}</th>
                <th scope="col" className={cellClass}>{messages.columnReview}</th>
                <th scope="col" className={cellClass}>{messages.columnAttempts}</th>
                <th scope="col" className={cellClass}>{messages.columnUpdated}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid="amux-card-row">
                  <td className={cellClass}>
                    <span className="block font-medium">{row.sourceKey ?? messages.none}</span>
                    <span className="block font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.id}</span>
                  </td>
                  <td className={cellClass}>{row.status}</td>
                  <td className={`${cellClass} font-mono text-xs`}>
                    {row.owner ?? messages.none}
                    {row.status === "todo" && row.owner !== null && !row.claimVerified
                      ? <span className="block font-sans text-amber-700 dark:text-amber-300">{messages.assignmentUnverified}</span> : null}
                  </td>
                  <td className={cellClass}>{row.priority}</td>
                  <td className={cellClass}>{row.kind}</td>
                  <td className={cellClass}>{row.briefPresent ? messages.briefPresent : messages.briefAbsent}</td>
                  <td className={cellClass}>
                    {row.requiresHumanReview ? messages.reviewRequired : messages.none}
                    {row.hasOwnerAttentionEscalation ? ` · ${messages.escalationOpen}` : ""}
                    {row.reviewPrNumber !== null ? ` · ${messages.pr(row.reviewPrNumber)}` : ""}
                  </td>
                  <td className={cellClass}>
                    {row.attemptCount}
                    {row.lastAttemptOutcome && row.lastAttemptToStatus
                      ? ` · ${messages.lastAttempt(row.lastAttemptOutcome, row.lastAttemptToStatus)}`
                      : ""}
                  </td>
                  <td className={`${cellClass} font-mono text-xs`}>{row.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? (
        <Link href={`/admin/amux-execution?tab=cards&cursor=${encodeURIComponent(nextCursor)}`}
          prefetch={false} className="self-start rounded border border-zinc-400 px-3 py-1 text-sm text-zinc-800 dark:text-zinc-100">
          {messages.nextPage(limit)}
        </Link>
      ) : null}
    </section>
  );
}
