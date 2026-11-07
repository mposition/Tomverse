"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { AdminDecisionAvatar } from "@/components/admin/AdminDecisionAvatar";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import {
  decisionAge,
  decisionHappened,
  decisionScreen,
  decisionSubtitle,
  decisionTitle,
  decisionWaitTone,
} from "@/lib/adminDecisionCopy";
import {
  decisionGroupOf,
  type DecisionArea,
  type DecisionGroupId,
  type DecisionInbox,
  type DecisionItem,
} from "@/lib/adminDecisionInbox";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { formatAestDateTime } from "@/lib/adminUiCore";

/**
 * The Decisions inbox: a list of what waits on a person, and for the chosen
 * item what happened and where it is decided.
 *
 * It only reads and links. The decision itself is made on the screen that owns
 * it, so this holds no write, no step-up and no confirmation. On a phone the
 * detail rises as a sheet from the bottom; from `lg` up it sits beside the
 * list.
 *
 * `area` filters the one list the page loaded; the area tabs are the same
 * inbox seen through a different filter, not a second source.
 */

const GROUP_ORDER: readonly DecisionGroupId[] = ["long", "recent", "unknown"];

// Static strings so Tailwind sees every class.
const AREA_CHIP: Record<DecisionArea, string> = {
  customers: "bg-emerald-500/15 text-emerald-300",
  agents: "bg-violet-500/15 text-violet-300",
  development: "bg-blue-500/15 text-blue-300",
  system: "bg-zinc-800 text-zinc-300",
};

const SEVERITY_DOT: Record<DecisionItem["severity"], string> = {
  critical: "bg-red-500",
  high: "bg-amber-500",
  normal: "bg-emerald-500",
};

export function AdminWorkQueuePanel({
  inbox,
  area,
  notices,
  truncatedNotice,
}: {
  inbox: DecisionInbox;
  /** `null` is the All tab. */
  area: DecisionArea | null;
  /**
   * What did not load, in sentences the page already wrote in the console's
   * language: a failed source, an unread count. An empty inbox is never drawn
   * as "clear" while one of these is present.
   */
  notices: string[];
  /** The "showing the oldest N" sentence when a source was cut short. */
  truncatedNotice: string | null;
}) {
  const home = useAdminMessages(adminHomeMessages);
  const d = home.decisions;
  const items = useMemo(
    () => (area ? inbox.items.filter((item) => item.area === area) : inbox.items),
    [inbox.items, area]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    rows: items.filter((item) => decisionGroupOf(inbox.waitHours[item.id] ?? null) === group),
  })).filter((entry) => entry.rows.length > 0);

  const next = () => {
    if (!selected) return;
    const index = items.findIndex((item) => item.id === selected.id);
    setSelectedId(items[(index + 1) % items.length].id);
    setSheetOpen(false);
  };

  const detail = (item: DecisionItem, idPrefix: string) => {
    const hours = inbox.waitHours[item.id];
    const startedAt = item.openedAt ? formatAestDateTime(item.openedAt) : null;
    const lines = [
      decisionHappened(item, home),
      item.detail,
      item.counted ? d.countedNote : d.detailLead(startedAt),
    ].filter((line) => line);
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid={`${idPrefix}-detail`}>
        <div className="flex items-start gap-3">
          <AdminDecisionAvatar item={item} size={52} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${AREA_CHIP[item.area]}`}>
                {home.areas[item.area]}
              </span>
              {item.counted ? null : (
                <AdminStatusChip tone={decisionWaitTone(hours)}>{d.waiting(decisionAge(hours, home))}</AdminStatusChip>
              )}
              <AdminStatusChip tone={item.severity === "critical" ? "bad" : item.severity === "high" ? "warn" : "idle"}>
                {d.severity[item.severity]}
              </AdminStatusChip>
            </div>
            <h3 className="mt-2 text-xl font-black text-white">{decisionTitle(item, home)}</h3>
            {item.subject ? <p className="mt-1 break-words text-sm text-zinc-400">{item.subject}</p> : null}
          </div>
        </div>

        <section>
          <h4 className="text-sm font-bold text-zinc-100">{d.happenedTitle}</h4>
          <ul className="mt-2 flex flex-col">
            {lines.map((line, index) => (
              <li key={index} className="flex items-start gap-3 border-t border-zinc-800 py-2.5 text-sm text-zinc-300">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    index === 0 ? SEVERITY_DOT[item.severity] : "bg-zinc-600"
                  }`}
                />
                <span className="min-w-0 break-words">{line}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h4 className="text-sm font-bold text-zinc-100">{d.whereTitle}</h4>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{d.kinds[item.kind].where}</p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={item.href}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
          >
            <ArrowRight className="h-4 w-4" aria-hidden />
            {d.openOn(decisionScreen(item, home))}
          </Link>
          {items.length > 1 ? (
            <button
              type="button"
              onClick={next}
              className="inline-flex min-h-11 items-center px-2 text-sm font-bold text-blue-300 hover:text-blue-200"
            >
              {d.later}
            </button>
          ) : null}
        </div>

        <AdminTechInfo summary={d.techSummary}>
          <dl className="grid gap-1">
            <div>
              <dt className="inline text-zinc-500">{d.techId}: </dt>
              <dd className="inline break-all">{item.id}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">{d.techHref}: </dt>
              <dd className="inline break-all">{item.href}</dd>
            </div>
            <div>
              <dt className="inline text-zinc-500">{d.techOpened}: </dt>
              <dd className="inline">{startedAt ?? "-"}</dd>
            </div>
          </dl>
        </AdminTechInfo>
      </div>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-decision-inbox">
      {notices.map((text) => (
        <p
          key={text}
          role="status"
          className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {text}
        </p>
      ))}
      {truncatedNotice ? (
        <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          {truncatedNotice}
        </p>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <AdminTile title={d.listLabel} description={d.readOnlyNote}>
          {items.length === 0 ? (
            notices.length > 0 ? (
              <AdminStateBlock kind="error" title={notices[0]} />
            ) : (
              <AdminStateBlock
                kind="empty"
                title={area ? d.empty.title : d.allEmpty.title}
                detail={area ? d.empty.detail : d.allEmpty.detail}
              />
            )
          ) : (
            <div className="flex flex-col gap-4">
              {grouped.map(({ group, rows }) => (
                <section key={group} aria-label={d.groups[group]}>
                  <h3 className="text-xs font-bold text-zinc-500">{d.groups[group]}</h3>
                  <ul className="mt-2 flex flex-col gap-2">
                    {rows.map((item) => {
                      const hours = inbox.waitHours[item.id];
                      const active = selected?.id === item.id;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            aria-pressed={active}
                            data-testid="admin-decision-row"
                            onClick={() => {
                              setSelectedId(item.id);
                              setSheetOpen(true);
                            }}
                            className={`flex w-full min-w-0 items-center gap-3 rounded-2xl border p-3 text-left transition ${
                              active
                                ? "border-blue-500 bg-blue-500/10"
                                : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700"
                            }`}
                          >
                            <AdminDecisionAvatar item={item} />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${AREA_CHIP[item.area]}`}>
                                  {home.areas[item.area]}
                                </span>
                                {item.counted ? null : (
                                  <AdminStatusChip tone={decisionWaitTone(hours)} className="px-2 py-0.5 text-[11px]">
                                    {decisionAge(hours, home)}
                                  </AdminStatusChip>
                                )}
                              </span>
                              <span className="mt-1 block truncate text-sm font-bold text-zinc-100">
                                {decisionTitle(item, home)}
                              </span>
                              <span className="block truncate text-xs text-zinc-500">{decisionSubtitle(item, home)}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </AdminTile>

        <div className="hidden min-w-0 lg:block">
          <AdminTile>
            {selected ? detail(selected, "admin-decision-pane") : <p className="text-sm text-zinc-500">{d.pick}</p>}
          </AdminTile>
        </div>
      </div>

      {sheetOpen && selected ? (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="admin-decision-sheet">
          <button
            type="button"
            aria-label={d.close}
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={decisionTitle(selected, home)}
            className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl border border-zinc-800 bg-zinc-900 p-5 pb-8"
          >
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                aria-label={d.close}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {detail(selected, "admin-decision-sheet")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
