"use client";

import { Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { AgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

/**
 * The QA-release section of the common Agent digest area: the newest
 * operator control revision and the recent digests, as counts and codes.
 * Read only (docs/policy/qa-release-agent.md section 4); the controls this
 * agent has -- recording a revision, clearing a latch -- arrive with their
 * own routes.
 */
export function AdminAgentDigestsPanel({ initial }: { initial: AgentDigestConsole }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const onOff = (value: boolean) => (value ? m.on : m.off);

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <Lock className="h-4 w-4" aria-hidden="true" />
        {m.readOnlyNote}
      </p>

      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.controlTitle}</h2>
        {initial.control ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="agent-digest-control">
            <dt className="text-zinc-600 dark:text-zinc-400">{m.revision}</dt>
            <dd>{initial.control.revision}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.digestEnabled}</dt>
            <dd>{onOff(initial.control.digestEnabled)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.mergeLaneEnabled}</dt>
            <dd>{onOff(initial.control.mergeLaneEnabled)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.developLaneOn}</dt>
            <dd>{onOff(initial.control.developLaneOn)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.iacCommit}</dt>
            <dd className="break-all font-mono text-xs">{initial.control.iacCommit ?? m.none}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">{m.recordedAt}</dt>
            <dd>{initial.control.createdAt}</dd>
          </dl>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.controlNone}</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.digestsTitle}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
        {initial.digests.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.emptyDigests}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="agent-digest-list">
            {initial.digests.map((row) => (
              <li key={row.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {m.digestDate}: {row.digestDate ?? m.none}
                </p>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {m.stored}: {row.createdAt} · {m.size}: {row.sizeBytes} B ·{" "}
                  <span className="break-all font-mono text-xs">{row.payloadSha256}</span>
                </p>
                {row.body === "expired" ? <p className="text-zinc-600 dark:text-zinc-400">{m.bodyExpired}</p> : null}
                {row.body === "unreadable" ? <p className="text-amber-800 dark:text-amber-300">{m.bodyUnreadable}</p> : null}
                {row.summary ? (
                  <div className="mt-2 flex flex-col gap-1 text-zinc-700 dark:text-zinc-300">
                    <p>
                      {m.gates}:{" "}
                      {Object.entries(row.summary.gatesByVerdict)
                        .map(([verdict, count]) => `${verdict} ${count}`)
                        .join(", ")}
                    </p>
                    <p>
                      {row.summary.issuesAvailable
                        ? fill(m.issues, { candidates: row.summary.issueCandidates, blocked: row.summary.issueBlocked })
                        : m.issuesUnavailable}
                    </p>
                    <p>{fill(m.checks, { count: row.summary.failedChecks })}</p>
                    <p>{fill(m.ci, { count: row.summary.failedCiJobs })}</p>
                    {row.summary.notChecked.length > 0 ? (
                      <p>
                        {m.notChecked}: <span className="font-mono text-xs">{row.summary.notChecked.join(", ")}</span>
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
