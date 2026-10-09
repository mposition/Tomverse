"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminSreOpsMessages } from "@/lib/adminMessages/sreOps";
import type { OpsObserverDigestView } from "@/lib/opsObserverDigest";

/**
 * One kept ops-observer daily digest (docs/policy/sre-ops.md §1 item 3, §8
 * S1b): the digest notice links here. In shadow its reservations are the
 * would-have-paged list, with the expected count per message kind; what the
 * daily cap held back (§5) is listed and counted separately, and each line
 * names its own mode. Read-only.
 */
export function AdminSreOpsDigestPanel({ view }: { view: OpsObserverDigestView }) {
  const m = useAdminMessages(adminSreOpsMessages);
  const label = (prefix: string, value: string) => (m as Record<string, string>)[`${prefix}_${value}`] ?? value;
  const payload = view.payload;
  // The counts cover every message of the date; the list may stop at its cap.
  const counts = payload ? payload.counts : [];
  const total = counts.reduce((sum, row) => sum + row.count, 0);

  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="sre-ops-digest">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.digestTitle}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.digestNote}</p>
      </div>

      {!payload ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="sre-ops-digest-gone">
          {m.digestBodyGone}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-600 dark:text-zinc-400">{m.digestOwnerDate}</dt>
            <dd>{payload.ownerDate}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.mode}</dt>
            <dd>{payload.mode}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.digestRecorded}</dt>
            <dd>{view.createdAt}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.itemChannelCheck}</dt>
            <dd>{payload.channelCheckTaken ? m.yes : m.no}</dd>
          </dl>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{m.digestReadiness}</h3>
            {payload.readiness === "unknown" ? (
              <p className="text-sm text-amber-800 dark:text-amber-300">{m.digestReadinessUnknown}</p>
            ) : Object.keys(payload.readiness).length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.digestReadinessNone}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" data-testid="sre-ops-digest-readiness">
                {Object.entries(payload.readiness).map(([name, ok]) => (
                  <li key={name} className="flex flex-wrap gap-2">
                    <span className="font-mono text-xs">{name}</span>
                    <span className={ok ? "text-zinc-700 dark:text-zinc-300" : "text-red-700 dark:text-red-300"}>
                      {ok ? m.digestReadinessOk : m.digestReadinessFailing}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{m.digestReserved}</h3>
            {/* An older digest recorded only one mode's reservations, so even an
                empty list does not say the date had no messages. */}
            {!view.countsComplete ? (
              <p className="text-sm text-amber-800 dark:text-amber-300" data-testid="sre-ops-digest-counts-partial">
                {m.digestCountsFromList}
              </p>
            ) : null}
            {total === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.digestNoReserved}</p>
            ) : (
              <>
                {payload.mode === "shadow" ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.digestWouldHavePaged}</p>
                ) : null}
                <ul className="flex flex-col gap-1 text-sm" data-testid="sre-ops-digest-counts">
                  {counts.map((row) => (
                    <li key={`${row.mode}-${row.status}-${row.kind}`}>
                      {row.mode} · {label("itemStatus", row.status)} · {label("kind", row.kind)} {row.count}
                    </li>
                  ))}
                </ul>
                {total > payload.items.length ? (
                  <p className="text-sm text-amber-800 dark:text-amber-300" data-testid="sre-ops-digest-truncated">
                    {m.digestListCapped
                      .replace("{shown}", String(payload.items.length))
                      .replace("{total}", String(total))}
                  </p>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="text-zinc-600 dark:text-zinc-400">
                      <tr>
                        <th className="py-1 pr-4 font-medium">{m.itemSignal}</th>
                        <th className="py-1 pr-4 font-medium">{m.itemKind}</th>
                        <th className="py-1 pr-4 font-medium">{m.mode}</th>
                        <th className="py-1 pr-4 font-medium">{m.digestItemStatus}</th>
                        <th className="py-1 pr-4 font-medium">{m.itemCapped}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payload.items.map((item, index) => (
                        <tr key={`${item.key}-${item.kind}-${index}`} className="border-t border-zinc-200 dark:border-zinc-800">
                          <td className="py-1 pr-4 font-mono text-xs">{item.key}</td>
                          <td className="py-1 pr-4">{label("kind", item.kind)}</td>
                          <td className="py-1 pr-4">{item.mode}</td>
                          <td className="py-1 pr-4">{label("itemStatus", item.status)}</td>
                          <td className="py-1 pr-4">{item.capped ? m.yes : m.no}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}

      <Link className="min-h-11 self-start text-sm font-medium underline" href="/admin/sre-ops">
        {m.backToChain}
      </Link>
    </section>
  );
}
