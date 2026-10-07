"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminSreOpsMessages } from "@/lib/adminMessages/sreOps";
import type { OpsObserverDeliveryView } from "@/lib/opsObserverStore";

/**
 * What one ops-observer page message was about (docs/policy/sre-ops.md §3
 * rule 1, §4). The message carries only the link to this screen; the keys,
 * message kinds, times and whether the cap counted each are shown here.
 * Read-only.
 */
export function AdminSreOpsItemPanel({ view }: { view: OpsObserverDeliveryView }) {
  const m = useAdminMessages(adminSreOpsMessages);
  const label = (prefix: string, value: string) => (m as Record<string, string>)[`${prefix}_${value}`] ?? value;

  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="sre-ops-item">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.itemTitle}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.itemNote}</p>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-600 dark:text-zinc-400">{m.itemStatus}</dt>
        <dd data-testid="sre-ops-item-status">{label("status", view.status)}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.mode}</dt>
        <dd>{view.mode}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.itemOwnerDate}</dt>
        <dd>{view.ownerDate}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.itemReservedAt}</dt>
        <dd>{view.reservedAt}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.itemClosedAt}</dt>
        <dd>{view.closedAt ?? "-"}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.itemChannelCheck}</dt>
        <dd>{view.channelCheck ? m.yes : m.no}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.genesisId}</dt>
        <dd className="break-all font-mono text-xs">{view.genesisId}</dd>
      </dl>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{m.itemSignals}</h3>
        {view.items.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.itemNoSignals}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm" data-testid="sre-ops-item-signals">
              <thead className="text-zinc-600 dark:text-zinc-400">
                <tr>
                  <th className="py-1 pr-4 font-medium">{m.itemSignal}</th>
                  <th className="py-1 pr-4 font-medium">{m.itemKind}</th>
                  <th className="py-1 pr-4 font-medium">{m.itemOpenedAt}</th>
                  <th className="py-1 pr-4 font-medium">{m.itemCapped}</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((item) => (
                  <tr key={`${item.signal}#${item.scope}`} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="py-1 pr-4 font-mono text-xs">
                      {item.signal}#{item.scope}
                    </td>
                    <td className="py-1 pr-4">{label("kind", item.kind)}</td>
                    <td className="py-1 pr-4">{item.openedAt}</td>
                    <td className="py-1 pr-4">{item.capped ? m.yes : m.no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Link className="min-h-11 self-start text-sm font-medium underline" href="/admin/sre-ops">
        {m.backToChain}
      </Link>
    </section>
  );
}
