"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { AmuxAdminCardRow } from "@/lib/amux/adminCardList";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";

const cellClass = "border-b border-zinc-200 px-2 py-1 align-top dark:border-zinc-700";

export function AmuxCardListPanel({
  rows,
  total,
  limit,
}: {
  rows: AmuxAdminCardRow[];
  total: number;
  limit: number;
}) {
  const messages = useAdminMessages(adminAmuxCardsMessages);
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-card-list-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-card-list-count">
        {messages.shown(rows.length, total, limit)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.empty}</p>
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
                  <td className={`${cellClass} font-mono text-xs`}>{row.owner ?? messages.none}</td>
                  <td className={cellClass}>{row.priority}</td>
                  <td className={cellClass}>{row.kind}</td>
                  <td className={cellClass}>{row.briefPresent ? messages.briefPresent : messages.briefAbsent}</td>
                  <td className={cellClass}>
                    {row.requiresHumanReview ? messages.reviewRequired : messages.none}
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
    </section>
  );
}
