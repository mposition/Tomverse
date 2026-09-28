"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminEngineeringAgentMessages } from "@/lib/adminMessages/engineeringAgent";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type {
  EngineeringAgentConsolePayload,
  EngineeringAgentOwnerItemView,
} from "@/lib/engineeringAgentConsoleRead";

const PAGE_PATH = "/admin/engineering-agent";
const FIRST_T1_WINDOW_DAYS = 14;

type Notice = { tone: "ok" | "error"; text: string } | null;

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

/**
 * The engineering agent console (docs/policy/engineering-agent.md §11, §12).
 *
 * Every control posts to its own `/api/admin/engineering-agent/*` route, which
 * checks the permission and a recent sign-in again. A refusal for a stale
 * sign-in (ADMIN_REAUTHENTICATION_REQUIRED) renders the way back to the
 * step-up flow, not only a message, as the Admin IA contract requires. A patch
 * is shown as text in a <pre> and never interpreted.
 */
export function AdminEngineeringAgentPanel({ initial }: { initial: EngineeringAgentConsolePayload }) {
  const m = useAdminMessages(adminEngineeringAgentMessages);
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);

  const post = async (key: string, url: string, body: Record<string, string>) => {
    setBusy(key);
    setNotice(null);
    try {
      const response = await fetch(url, {
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
      setNotice({ tone: "ok", text: m.done });
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: m.failed });
    } finally {
      setBusy(null);
    }
  };

  const decide = (item: EngineeringAgentOwnerItemView, decision: "approved" | "rejected") => {
    if (!item.patchDigest || !item.baseSha) return;
    if (!window.confirm(decision === "approved" ? m.confirmApprove : m.confirmReject)) return;
    void post(`${item.id}:${decision}`, "/api/admin/engineering-agent/decisions", {
      workItemId: item.id,
      decision,
      patchDigest: item.patchDigest,
      baseSha: item.baseSha,
    });
  };

  const button = (key: string, label: string, onClick: () => void, tone: "primary" | "danger" | "plain" = "plain") => (
    <button
      type="button"
      disabled={busy !== null}
      onClick={onClick}
      className={[
        "inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50",
        tone === "primary"
          ? "border-blue-600 bg-blue-600 text-white"
          : tone === "danger"
            ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
            : "border-zinc-300 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200",
      ].join(" ")}
    >
      {busy === key ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {label}
    </button>
  );

  const kindLabel = (kind: EngineeringAgentOwnerItemView["kind"]) =>
    kind === "t2_draft" ? m.kindT2 : kind === "decision" ? m.kindDecision : m.kindMismatch;

  return (
    <section className="flex min-w-0 flex-col gap-4">
      {!initial.canWrite ? (
        <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <Lock className="h-4 w-4" aria-hidden="true" />
          {m.readOnlyNote}
        </p>
      ) : null}

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

      {initial.queue ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {fill(m.totals, {
              t2: initial.queue.totals.t2_draft,
              decision: initial.queue.totals.decision,
              mismatch: initial.queue.totals.state_mismatch,
            })}{" "}
            {fill(m.showingOldest, { count: initial.limit })}
          </p>
          {initial.queue.items.length === 0 ? <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.emptyQueue}</p> : null}
          <ul className="flex flex-col gap-3">
            {initial.queue.items.map((item) => (
              <li key={item.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{kindLabel(item.kind)}</p>
                  <p className="text-xs text-zinc-500">{item.createdAt}</p>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {item.reason ? (
                    <>
                      <dt className="text-zinc-500">{m.reason}</dt>
                      <dd className="font-mono">{item.reason}</dd>
                    </>
                  ) : null}
                  {item.runId ? (
                    <>
                      <dt className="text-zinc-500">{m.run}</dt>
                      <dd className="font-mono">{item.runId}</dd>
                    </>
                  ) : null}
                  {item.baseSha ? (
                    <>
                      <dt className="text-zinc-500">{m.base}</dt>
                      <dd className="break-all font-mono">{item.baseSha}</dd>
                    </>
                  ) : null}
                  {item.patchDigest ? (
                    <>
                      <dt className="text-zinc-500">{m.digest}</dt>
                      <dd className="break-all font-mono">{item.patchDigest}</dd>
                    </>
                  ) : null}
                </dl>
                {item.patchBody !== null ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium">{m.patch}</summary>
                    <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
                      {item.patchBody}
                    </pre>
                  </details>
                ) : null}
                {item.kind === "state_mismatch" ? (
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{m.mismatchNote}</p>
                ) : null}
                {initial.canWrite && item.kind === "t2_draft" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {button(`${item.id}:approved`, m.approve, () => decide(item, "approved"), "primary")}
                    {button(`${item.id}:rejected`, m.reject, () => decide(item, "rejected"), "danger")}
                  </div>
                ) : null}
                {initial.canWrite && item.kind === "decision" ? (
                  <div className="mt-3">
                    {button(`${item.id}:ack`, m.acknowledge, () =>
                      void post(`${item.id}:ack`, "/api/admin/engineering-agent/acknowledgements", { workItemId: item.id }),
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {initial.runs ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
          {initial.runs.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.emptyRuns}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">{m.run}</th>
                    <th className="px-2 py-1 font-medium">{m.card}</th>
                    <th className="px-2 py-1 font-medium">{m.modeAtStart}</th>
                    <th className="px-2 py-1 font-medium">{m.status}</th>
                    <th className="px-2 py-1 font-medium">{m.outcome}</th>
                    <th className="px-2 py-1 font-medium">{m.halt}</th>
                    <th className="px-2 py-1 font-medium">{m.started}</th>
                    <th className="px-2 py-1 font-medium">{m.ended}</th>
                  </tr>
                </thead>
                <tbody>
                  {initial.runs.map((run) => (
                    <tr key={run.id} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="px-2 py-1 font-mono">{run.id}</td>
                      <td className="px-2 py-1 font-mono">{run.cardId}</td>
                      <td className="px-2 py-1">{run.modeAtStart}</td>
                      <td className="px-2 py-1">{run.status}</td>
                      <td className="px-2 py-1">{run.outcome ?? ""}</td>
                      <td className="px-2 py-1">{run.halt}</td>
                      <td className="px-2 py-1 text-xs">{run.startedAt}</td>
                      <td className="px-2 py-1 text-xs">{run.endedAt ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {initial.pullRequests ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
          {initial.pullRequests.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.emptyPullRequests}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">{m.pullRequest}</th>
                    <th className="px-2 py-1 font-medium">{m.run}</th>
                    <th className="px-2 py-1 font-medium">{m.state}</th>
                    <th className="px-2 py-1 font-medium">{m.current}</th>
                    <th className="px-2 py-1 font-medium">{m.approval}</th>
                    <th className="px-2 py-1 font-medium">{m.merged}</th>
                  </tr>
                </thead>
                <tbody>
                  {initial.pullRequests.map((row) => (
                    <tr key={row.id} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="px-2 py-1 font-mono">#{row.prNumber}</td>
                      <td className="px-2 py-1 font-mono">{row.runId}</td>
                      <td className="px-2 py-1">{row.state}</td>
                      <td className="px-2 py-1">{row.current ? m.current : m.superseded}</td>
                      <td className="px-2 py-1">{row.approvalVerdict ?? m.notObserved}</td>
                      <td className="px-2 py-1">{row.merged === null ? m.notObserved : row.merged ? m.yes : m.no}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {initial.settings ? (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500">{m.mode}</dt>
            <dd className="font-mono">{initial.settings.mode}</dd>
            <dt className="text-zinc-500">{m.freeze}</dt>
            <dd>{initial.settings.frozen ? m.on : m.off}</dd>
            <dt className="text-zinc-500">{m.registration}</dt>
            <dd>{initial.settings.registration ? m.on : m.off}</dd>
            <dt className="text-zinc-500">{m.killSwitch}</dt>
            <dd>{initial.settings.killSwitch ? m.engaged : m.notEngaged}</dd>
          </dl>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {initial.settings.pullRequests.firstT1Window
              ? fill(m.prQueueWindow, {
                  occupied: initial.settings.pullRequests.occupied,
                  limit: initial.settings.pullRequests.limit,
                  days: FIRST_T1_WINDOW_DAYS,
                })
              : fill(m.prQueue, {
                  occupied: initial.settings.pullRequests.occupied,
                  limit: initial.settings.pullRequests.limit,
                })}
            <br />
            {fill(m.decisionQueue, {
              occupied: initial.settings.decisions.occupied,
              limit: initial.settings.decisions.limit,
            })}
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.queueNote}</p>
          {initial.canWrite ? (
            <div className="flex flex-wrap gap-2">
              {button("mode:off", m.setOff, () =>
                void post("mode:off", "/api/admin/engineering-agent/settings", { name: "mode", value: "off" }),
              )}
              {button("mode:shadow", m.setShadow, () =>
                void post("mode:shadow", "/api/admin/engineering-agent/settings", { name: "mode", value: "shadow" }),
              )}
              {initial.settings.frozen
                ? button("freeze:false", m.freezeOff, () =>
                    void post("freeze:false", "/api/admin/engineering-agent/settings", { name: "freeze", value: "false" }),
                  )
                : button("freeze:true", m.freezeOn, () =>
                    void post("freeze:true", "/api/admin/engineering-agent/settings", { name: "freeze", value: "true" }),
                  )}
            </div>
          ) : null}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.t1Note}</p>
        </div>
      ) : null}
    </section>
  );
}
