"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminBillingFinanceOpsDigestsMessages } from "@/lib/adminMessages/billingFinanceOpsDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { BillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";

const PAGE_PATH = "/admin/agent-digests?tab=billing-finance-ops";
const CONTROL_ROUTE = "/api/admin/agent-digests/billing-finance-ops/control";
const MONITORS_ROUTE = "/api/admin/agent-digests/billing-finance-ops/monitor-confirmation";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

/**
 * The billing-finance-ops tab of the common Agent digest area
 * (docs/policy/billing-finance-ops.md §1.2–1.4): the app switch, the monitor
 * confirmation and the recent digests, re-read through the closed schema. The
 * two writes are offered only to owner and ops; their routes check the role
 * and a recent sign-in again, and a stale sign-in is answered with the way
 * back. React escapes every value it renders.
 */
export function AdminBillingFinanceOpsDigestsPanel({ initial }: { initial: BillingFinanceOpsConsole }) {
  const m = useAdminMessages(adminBillingFinanceOpsDigestsMessages);
  const stateLabel =
    initial.control.state === "enabled"
      ? m.stateEnabled
      : initial.control.state === "disabled"
        ? m.stateDisabled
        : m.stateUnreadable;

  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="billing-finance-ops-tab">
      <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <Lock className="h-4 w-4" aria-hidden="true" />
        {m.readOnlyNote}
      </p>

      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.switchTitle}</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="billing-finance-ops-switch">
          <dt className="text-zinc-600 dark:text-zinc-400">{m.state}</dt>
          <dd className={initial.control.state === "unreadable" ? "text-amber-800 dark:text-amber-300" : undefined}>
            {stateLabel}
          </dd>
          <dt className="text-zinc-600 dark:text-zinc-400">{m.revision}</dt>
          <dd>{initial.control.revision ?? m.none}</dd>
          <dt className="text-zinc-600 dark:text-zinc-400">{m.enabledAt}</dt>
          <dd>{initial.control.enabledAt ?? m.none}</dd>
          <dt className="text-zinc-600 dark:text-zinc-400">{m.monitorConfirmedAt}</dt>
          <dd>{initial.monitorConfirmedAt ?? m.none}</dd>
        </dl>
        {initial.canWrite ? <BillingFinanceOpsControls state={initial.control.state} /> : null}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.digestsTitle}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
        {initial.digests.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.emptyDigests}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="billing-finance-ops-digest-list">
            {initial.digests.map((row) => (
              <li key={row.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {m.digestDate}: {row.digest?.computedAtDate ?? m.none}
                  {row.digest ? ` · ${m.environment}: ${row.digest.environment} · ${m.verdict}: ${row.digest.verdict}` : ""}
                </p>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {m.stored}: {row.createdAt} · {m.size}: {row.sizeBytes} B
                </p>
                {row.body === "expired" ? <p className="text-zinc-600 dark:text-zinc-400">{m.bodyExpired}</p> : null}
                {row.body === "unreadable" ? <p className="text-amber-800 dark:text-amber-300">{m.bodyUnreadable}</p> : null}
                {row.digest ? (
                  <div className="mt-2 flex flex-col gap-1 text-zinc-700 dark:text-zinc-300">
                    {row.digest.items.length === 0 ? (
                      <p>{m.noItems}</p>
                    ) : (
                      <ul className="flex flex-col gap-1" aria-label={m.items}>
                        {row.digest.items.map((item) => (
                          <li key={`${item.modelId}-${item.registeredAt}`} className="break-all">
                            <span className="font-mono text-xs">{item.modelId}</span> · {item.expiresAt} ·{" "}
                            {item.remainingDays === null ? m.remainingUnknown : fill(m.remainingDays, { days: item.remainingDays })}{" "}
                            · {item.mark}
                          </li>
                        ))}
                      </ul>
                    )}
                    {row.digest.rejectedFields.length > 0 ? (
                      <p>
                        {m.rejected}:{" "}
                        <span className="font-mono text-xs">
                          {row.digest.rejectedFields.map((field) => `#${field.index} ${field.field}`).join(", ")}
                        </span>
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
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
      className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
      data-testid={testId}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.monitorNote}</p>
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
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={notice.tone === "ok" ? "text-sm text-zinc-700 dark:text-zinc-300" : "text-sm text-red-700 dark:text-red-300"}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
