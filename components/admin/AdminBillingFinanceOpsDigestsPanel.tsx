"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Minus } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminFetch } from "@/lib/adminFetch";
import { adminBillingFinanceAgentMessages } from "@/lib/adminMessages/billingFinanceAgent";
import { adminBillingFinanceOpsDigestsMessages } from "@/lib/adminMessages/billingFinanceOpsDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { financeFigures } from "@/lib/billingFinanceAgentCore";
import type { BillingFinanceOpsConsole, BillingFinanceOpsConsoleRow } from "@/lib/billingFinanceOpsConsoleRead";

const PAGE_PATH = "/admin/finance-agent";
const CONTROL_ROUTE = "/api/admin/agent-digests/billing-finance-ops/control";
const MONITORS_ROUTE = "/api/admin/agent-digests/billing-finance-ops/monitor-confirmation";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

export type FinanceAgentSection = "overview" | "report" | "settings";

/**
 * The billing-finance-ops agent's three tabs (docs/policy/billing-finance-ops.md
 * §1.2-1.4): Overview (four figures from the newest readable digest, the
 * report calendar and the mode), Daily report (the recent digests, re-read
 * through the closed schema) and Settings (the app switch, the monitor
 * confirmation and the two writes). The two writes are offered only to owner
 * and ops; their routes check the role and a recent sign-in again, and a stale
 * sign-in is answered with the way back. React escapes every value it renders.
 *
 * A figure that no digest body can give is "Unavailable", never zero, and an
 * unreadable switch is never drawn as off.
 */
export function AdminBillingFinanceOpsDigestsPanel({
  initial,
  section,
}: {
  initial: BillingFinanceOpsConsole;
  section: FinanceAgentSection;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="billing-finance-ops-tab">
      {section === "overview" ? <FinanceOverview initial={initial} /> : null}
      {section === "report" ? <FinanceReport initial={initial} /> : null}
      {section === "settings" ? <FinanceSettings initial={initial} /> : null}
    </section>
  );
}

const VERDICT_TONE: Record<string, AdminTone> = { quiet: "ok", notice: "warn", register_invalid: "bad" };

function FinanceOverview({ initial }: { initial: BillingFinanceOpsConsole }) {
  const m = useAdminMessages(adminBillingFinanceAgentMessages);
  const figures = financeFigures(initial.digests);
  const latest = figures.latest?.digest ?? null;
  const control = initial.control;
  const modeLabel = control.state === "enabled" ? m.mode.watching : control.state === "disabled" ? m.mode.off : m.mode.unreadable;
  const modeTone: AdminTone = control.state === "enabled" ? "ok" : control.state === "disabled" ? "idle" : "unknown";
  const modeDetail =
    control.state === "enabled" ? m.mode.watchingDetail : control.state === "disabled" ? m.mode.offDetail : m.mode.unreadableDetail;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="finance-overview">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={m.kpi.waiting}
          value={figures.waiting}
          detail={latest ? m.kpi.waitingDetail(latest.computedAtDate) : undefined}
        />
        <AdminKpiCard
          label={m.kpi.nearest}
          value={figures.nearest ? m.kpi.nearestDays(figures.nearest.days) : null}
          detail={figures.nearest ? m.kpi.nearestDetail(figures.nearest.modelId) : undefined}
          tone={figures.nearest && figures.nearest.days <= 7 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.kpi.soon}
          value={figures.soon}
          detail={figures.soon === null ? undefined : m.kpi.soonDetail}
          tone={figures.soon !== null && figures.soon > 0 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.kpi.last}
          value={latest ? latest.computedAtDate : null}
          detail={latest ? m.kpi.lastDetail(m.verdict[latest.verdict]) : undefined}
          tone={latest?.verdict === "register_invalid" ? "bad" : latest?.verdict === "notice" ? "warn" : "neutral"}
        />
      </div>

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <AdminTile
          title={m.calendar.title}
          description={figures.calendar.length > 0 ? m.calendar.description(figures.calendar.length) : undefined}
        >
          {figures.calendar.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.report.empty} />
          ) : (
            <ul className="flex flex-wrap gap-2" data-testid="finance-calendar">
              {figures.calendar.map((day) => (
                <li
                  key={day.id}
                  data-tone={day.tone}
                  title={m.calendar.day(day.label, day.verdict ? m.verdict[day.verdict] : m.calendar.unreadable)}
                  className={`flex w-14 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-bold ${
                    day.tone === "ok"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : day.tone === "warn"
                        ? "bg-amber-500/15 text-amber-300"
                        : day.tone === "bad"
                          ? "bg-red-500/15 text-red-300"
                          : "border border-dashed border-zinc-700 text-zinc-400"
                  }`}
                >
                  <span>{day.label}</span>
                  {day.tone === "ok" ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : day.tone === "unknown" ? (
                    <Minus className="h-4 w-4" aria-hidden />
                  ) : (
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                  )}
                </li>
              ))}
            </ul>
          )}
        </AdminTile>

        <AdminTile title={m.mode.title}>
          <div className="flex flex-wrap items-center gap-2">
            <AdminStatusChip tone={modeTone}>{modeLabel}</AdminStatusChip>
            {control.enabledAt ? (
              <span className="text-xs text-zinc-500">{m.mode.since(formatAestDateTime(control.enabledAt) ?? "-")}</span>
            ) : null}
          </div>
          <p className="text-sm leading-6 text-zinc-400">{modeDetail}</p>
          <Link href="/admin/finance-agent?tab=settings" className="self-start text-sm font-bold text-blue-300 hover:underline">
            {m.mode.change}
          </Link>
        </AdminTile>
      </div>
    </div>
  );
}

function FinanceReport({ initial }: { initial: BillingFinanceOpsConsole }) {
  const m = useAdminMessages(adminBillingFinanceAgentMessages);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="billing-finance-ops-digest-list">
      <p className="text-sm text-zinc-400">{m.report.description(initial.limit)}</p>
      {initial.digests.length === 0 ? (
        <AdminStateBlock kind="empty" title={m.report.empty} />
      ) : (
        initial.digests.map((row, index) => <FinanceDigest key={row.id} row={row} open={index === 0} />)
      )}
    </div>
  );
}

function FinanceDigest({ row, open }: { row: BillingFinanceOpsConsoleRow; open: boolean }) {
  const m = useAdminMessages(adminBillingFinanceAgentMessages);
  const digest = row.digest;
  const date = digest?.computedAtDate ?? formatAestDateTime(row.createdAt) ?? "-";
  const tone: AdminTone = digest ? (VERDICT_TONE[digest.verdict] ?? "unknown") : "unknown";
  const markLabel = (mark: string) =>
    mark === "none" ? m.report.markNone : mark === "expired" ? m.report.markExpired : m.report.markDays(mark);
  const daysText = (days: number | null) => (days === null ? m.report.unknownDays : m.report.daysLeft(days));
  return (
    <details open={open} className="group rounded-2xl border border-zinc-800 bg-zinc-900 p-5" data-testid="billing-finance-ops-digest">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 [&::-webkit-details-marker]:hidden">
        <span className="text-base font-bold text-white">{date}</span>
        <AdminStatusChip tone={tone}>{digest ? m.verdict[digest.verdict] : m.calendar.unreadable}</AdminStatusChip>
        <span className="text-xs text-zinc-500">
          {m.report.stored} {formatAestDateTime(row.createdAt) ?? "-"}
          {digest ? ` · ${m.report.environment} ${digest.environment}` : ""}
        </span>
      </summary>
      <div className="mt-4 flex flex-col gap-3">
        {row.body === "expired" ? <AdminStateBlock kind="empty" title={m.report.expired} /> : null}
        {row.body === "unreadable" ? <AdminStateBlock kind="error" title={m.report.unreadableBody} /> : null}
        {digest ? (
          <>
            <AdminDataTable
              caption={date}
              rows={digest.items}
              rowKey={(item) => `${item.modelId}-${item.registeredAt}`}
              emptyState={<AdminStateBlock kind="empty" title={m.report.noItems} />}
              columns={[
                { key: "model", header: m.report.model, render: (item) => <span className="font-mono text-xs">{item.modelId}</span> },
                { key: "expires", header: m.report.expires, render: (item) => item.expiresAt },
                { key: "left", header: m.report.remaining, render: (item) => daysText(item.remainingDays) },
                { key: "mark", header: m.report.mark, render: (item) => markLabel(item.mark) },
              ]}
              cardTitle={(item) => <span className="font-mono text-xs">{item.modelId}</span>}
              cardMeta={(item) => `${item.expiresAt} · ${daysText(item.remainingDays)}`}
            />
            {digest.rejectedFields.length > 0 ? (
              <p className="text-sm text-amber-300">
                {m.report.rejected}:{" "}
                <span className="font-mono text-xs">
                  {digest.rejectedFields.map((field) => `#${field.index} ${field.field}`).join(", ")}
                </span>
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function FinanceSettings({ initial }: { initial: BillingFinanceOpsConsole }) {
  const m = useAdminMessages(adminBillingFinanceOpsDigestsMessages);
  const a = useAdminMessages(adminBillingFinanceAgentMessages);
  const tone: AdminTone =
    initial.control.state === "enabled" ? "ok" : initial.control.state === "disabled" ? "idle" : "unknown";
  return (
    <AdminTile title={a.settings.switchTitle} description={a.settings.switchDescription}>
      <div data-testid="billing-finance-ops-switch" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <AdminStatusChip tone={tone}>
            {initial.control.state === "enabled" ? a.mode.watching : initial.control.state === "disabled" ? a.mode.off : a.mode.unreadable}
          </AdminStatusChip>
          {initial.control.state === "unreadable" ? <p className="text-sm text-amber-300">{m.stateUnreadable}</p> : null}
        </div>
        <AdminTechInfo summary={a.settings.techSummary}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt>{a.settings.revision}</dt>
            <dd>{initial.control.revision ?? a.settings.none}</dd>
            <dt>{a.settings.enabledAt}</dt>
            <dd>{formatAestDateTime(initial.control.enabledAt) ?? a.settings.none}</dd>
            <dt>{a.settings.monitorConfirmedAt}</dt>
            <dd>{formatAestDateTime(initial.monitorConfirmedAt) ?? a.settings.none}</dd>
          </dl>
        </AdminTechInfo>
      </div>
      {initial.canWrite ? (
        <BillingFinanceOpsControls state={initial.control.state} />
      ) : (
        <p className="text-sm text-zinc-400">{m.readOnlyNote}</p>
      )}
    </AdminTile>
  );
}

type Notice = { tone: "ok" | "error"; text: string } | null;

function BillingFinanceOpsControls({ state }: { state: BillingFinanceOpsConsole["control"]["state"] }) {
  const m = useAdminMessages(adminBillingFinanceOpsDigestsMessages);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);

  const post = async (route: string, body: Record<string, unknown>, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { code?: unknown };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (response.status === 409 && typeof payload.code === "string") {
        setNotice({ tone: "error", text: fill(m.refused, { code: payload.code }) });
        return;
      }
      if (!response.ok) {
        setNotice({ tone: "error", text: m.failed });
        return;
      }
      setNotice({ tone: "ok", text: m.saved });
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: m.failed });
    } finally {
      setBusy(false);
    }
  };

  const button = (label: string, onClick: () => void, testId: string) => (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="min-h-11 rounded-md px-4 text-sm font-medium disabled:opacity-60 bg-zinc-100 text-zinc-900"
      data-testid={testId}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 border-zinc-800">
      <p className="text-sm text-zinc-400">{m.monitorNote}</p>
      <div className="flex flex-wrap gap-2">
        {state === "enabled"
          ? null
          : state === "disabled"
            ? button(m.turnOn, () => void post(CONTROL_ROUTE, { enabled: true }, m.confirmTurnOn), "billing-finance-ops-turn-on")
            : null}
        {state === "disabled"
          ? null
          : button(m.turnOff, () => void post(CONTROL_ROUTE, { enabled: false }, m.confirmTurnOff), "billing-finance-ops-turn-off")}
        {button(m.recordMonitors, () => void post(MONITORS_ROUTE, {}, m.confirmMonitors), "billing-finance-ops-record-monitors")}
      </div>
      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={notice.tone === "ok" ? "text-sm text-zinc-300" : "text-sm text-red-300"}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
