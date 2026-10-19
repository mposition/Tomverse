import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";

import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAmuxBacklogListMessages } from "@/lib/adminMessages/amuxBacklogList";
import { amuxBacklogHref } from "@/lib/amux/adminBacklogListCore";
import type { AmuxBacklogList } from "@/lib/amux/adminBacklogRead";

export async function AmuxBacklogListPanel({ data, search, valid }: {
  data: AmuxBacklogList | null; search: string; valid: boolean;
}) {
  const m = await getAdminMessages(adminAmuxBacklogListMessages);
  const iconClass = "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 hover:bg-zinc-800";
  const cellClass = "border-b px-3 py-3 border-zinc-800";
  return <section className="flex min-w-0 flex-col gap-4" data-testid="amux-backlog-list">
    <h2 className="text-lg font-semibold">{m.title}</h2>
    {!data && valid ? <p>
      {m.reauthenticate}{" "}
      <Link className="underline" href={adminRecentAuthenticationHref(amuxBacklogHref(search))}>
        {m.signIn}
      </Link>
    </p> : <>
      <form action="/admin/amux-backlog" method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="list" />
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          {m.search}
          <input key={search} type="search" name="cardNumber" defaultValue={search} maxLength={128}
            placeholder={m.searchPlaceholder} className="h-9 w-72 max-w-full rounded-md border bg-transparent px-3 border-zinc-700" />
        </label>
        <button type="submit" className={iconClass} aria-label={m.search} title={m.search}>
          <Search size={16} />
        </button>
        {search && <Link href={amuxBacklogHref("")} className={iconClass} aria-label={m.clear} title={m.clear}>
          <X size={16} />
        </Link>}
      </form>
      {!valid ? <p role="alert">{m.invalidSearch}</p> : data && <>
        <p className="text-sm text-zinc-400" data-testid="amux-backlog-count">
          {m.shown(data.rows.length, data.total)}
        </p>
        {data.rows.length === 0 ? <p>{search ? m.noMatches : m.empty}</p> :
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] table-fixed text-left text-sm" data-testid="amux-backlog-table">
              <thead><tr>
                <th scope="col" className={`${cellClass} w-48`}>{m.cardNumber}</th>
                <th scope="col" className={`${cellClass} w-32`}>{m.createdAt}</th>
                <th scope="col" className={cellClass}>{m.summary}</th>
                <th scope="col" className={`${cellClass} w-28 text-right`}>{m.score}</th>
              </tr></thead>
              <tbody>{data.rows.map((row) => <tr key={row.id} data-testid="amux-backlog-row">
                <td className={`${cellClass} break-all font-mono text-xs`} title={row.id}>
                  <Link className="underline underline-offset-2" href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(row.id)}`}>
                    {row.cardNumber}
                  </Link>
                </td>
                <td className={cellClass}><time dateTime={row.createdAt} title={row.createdAt}>
                  {new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.createdAt))}
                </time></td>
                <td className={cellClass}><span className="block truncate" title={row.summary ?? undefined}>
                  {row.summary ?? (row.summaryUnavailable ? m.summaryUnavailable : m.summaryNotStored)}
                </span></td>
                <td className={`${cellClass} text-right tabular-nums`}>
                  {row.score ?? m.unscored}
                  {row.score !== null && !row.scoreFresh && <span className="block text-xs text-amber-400">{m.stale}</span>}
                </td>
              </tr>)}</tbody>
            </table>
          </div>}
        <nav aria-label={m.page(data.page, data.pageCount)} className="flex items-center justify-end gap-3">
          {data.page > 1 && <Link href={amuxBacklogHref(search, data.page - 1)} className={iconClass} aria-label={m.previous} title={m.previous}><ChevronLeft size={16} /></Link>}
          <span className="text-sm">{m.page(data.page, data.pageCount)}</span>
          {data.page < data.pageCount && <Link href={amuxBacklogHref(search, data.page + 1)} className={iconClass} aria-label={m.next} title={m.next}><ChevronRight size={16} /></Link>}
        </nav>
      </>}
    </>}
  </section>;
}
