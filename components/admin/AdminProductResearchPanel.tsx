"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminProductResearchMessages } from "@/lib/adminMessages/productResearch";
import type { ProductResearchConsoleView } from "@/lib/productResearchConsoleRead";

/**
 * The product-research agent's observation record
 * (docs/policy/product-research-agent.md §4).
 *
 * There is no control on this screen and there is not meant to be: the agent
 * copies a judgement the backlog report already made and proposes nothing, so
 * there is nothing to approve or reject. The heading is fixed copy from the
 * policy for the same reason -- a table of open issues beside a verdict reads
 * as a to-do list unless it says otherwise.
 *
 * Every string here comes from the stored row and is rendered as text. Issue
 * titles are public text that went through normalisation and a secret scan
 * before storage; React escapes them, and nothing on this screen interprets
 * one.
 */
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    template,
  );

const SHORT_SHA = (sha: string | null) => (sha === null ? "-" : sha.slice(0, 12));

export function AdminProductResearchPanel({ initial }: { initial: ProductResearchConsoleView }) {
  const m = useAdminMessages(adminProductResearchMessages);

  // The four off-nominal states are said in words rather than shown as an
  // empty table, because an empty table reads as nothing being wrong.
  const status =
    initial.silence.state === "disabled"
      ? { tone: "muted" as const, text: m.disabled }
      : initial.silence.state === "anchor_missing"
        ? { tone: "warn" as const, text: m.anchorMissing }
        : initial.silence.state === "no_observation_yet"
          ? { tone: "warn" as const, text: m.noObservationYet }
          : initial.silence.state === "silent"
            ? {
                tone: "warn" as const,
                text: fill(m.silent, { hours: Math.round(initial.silence.sinceHours ?? 0) }),
              }
            : {
                tone: "muted" as const,
                text: fill(m.recent, { slot: initial.lastSuccessAt ?? "-" }),
              };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {initial.heading}
        </h2>
        <p
          className={`mt-2 text-sm ${
            status.tone === "warn"
              ? "text-amber-700 dark:text-amber-400"
              : "text-zinc-600 dark:text-zinc-400"
          }`}
        >
          {status.text}
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          {fill(m.showingSlots, { count: initial.limit })}{" "}
          {fill(m.retention, { days: initial.retentionDays })}
        </p>
      </section>

      <section className="min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2">{m.slotColumn}</th>
              <th className="px-3 py-2">{m.stateColumn}</th>
              <th className="px-3 py-2">{m.issuesColumn}</th>
              <th className="px-3 py-2">{m.commitsColumn}</th>
              <th className="px-3 py-2">{m.digestColumn}</th>
              <th className="px-3 py-2">{m.submittedColumn}</th>
            </tr>
          </thead>
          <tbody>
            {initial.slots.map((slot) => (
              <tr key={slot.slot} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2 font-mono text-xs">{slot.slot}</td>
                <td className="px-3 py-2">
                  {slot.stateLabel ?? slot.state}
                  {slot.failureStageLabel === null ? null : (
                    <span className="block text-xs text-zinc-500">{slot.failureStageLabel}</span>
                  )}
                </td>
                <td className="px-3 py-2">{slot.issueCount ?? "-"}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {SHORT_SHA(slot.developSha)} / {SHORT_SHA(slot.mainSha)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{SHORT_SHA(slot.payloadDigest)}</td>
                <td className="px-3 py-2 font-mono text-xs">{slot.submittedAt ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="min-w-0 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {m.latestHeading}
        </h2>
        {initial.latest === null ? (
          // Two different absences. "Nothing was ever recorded" and "the slot
          // that just passed has no observation" look the same on an empty
          // screen, and only the second one is a fault.
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {initial.latestOmitted === "current_slot_not_recorded"
              ? m.latestNotCurrent
              : m.latestEmpty}
          </p>
        ) : (
          <>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {initial.latest.slot} · {SHORT_SHA(initial.latest.developSha)} /{" "}
              {SHORT_SHA(initial.latest.mainSha)} · {SHORT_SHA(initial.latest.payloadDigest)}
            </p>
            {/*
              The distribution, because counting a column of up to 200 rows by
              eye is work a screen can do. Recounted from the rows rendered
              below rather than read off the payload, so what is counted is
              what is shown; `summary` is null when the stored payload cannot
              say, and an unknown count renders nothing rather than a zero.
            */}
            {initial.latest.summary === null ? null : (
              <div className="mt-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  {m.summaryHeading}
                </h3>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  {initial.latest.summary.verdicts.map((entry) => (
                    <div key={entry.verdict} className="flex min-w-0 justify-between gap-3">
                      <dt className="min-w-0 text-sm text-zinc-600 dark:text-zinc-400">
                        {entry.label ?? entry.verdict}
                      </dt>
                      <dd className="font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                        {entry.count}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {fill(m.summaryBlindSpots, {
                    noSignal: initial.latest.summary.blindSpots.noSignalIssues,
                    oneBranch: initial.latest.summary.blindSpots.oneBranchOnly,
                  })}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {fill(m.summaryNote, { count: initial.latest.summary.issueCount })}
                </p>
                {initial.latest.summary.storedCountsAgree ? null : (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                    {m.summaryMismatch}
                  </p>
                )}
              </div>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[42rem] text-left text-sm">
                <thead className="text-xs uppercase text-zinc-500 dark:text-zinc-400">
                  <tr>
                    <th className="px-3 py-2">{m.issueColumn}</th>
                    <th className="px-3 py-2">{m.titleColumn}</th>
                    <th className="px-3 py-2">{m.verdictColumn}</th>
                    <th className="px-3 py-2">{m.branchesColumn}</th>
                  </tr>
                </thead>
                <tbody>
                  {initial.latest.issues.map((issue) => (
                    <tr key={issue.id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-3 py-2 font-mono text-xs">{issue.id}</td>
                      <td className="px-3 py-2">
                        {issue.title}
                        {issue.blockedOnPresent ? (
                          <span className="block text-xs text-zinc-500">{m.blockedOn}</span>
                        ) : null}
                      </td>
                      {/* The source's own verdict, in the label the policy fixes. */}
                      <td className="px-3 py-2">{issue.verdictLabel ?? issue.verdict}</td>
                      <td className="px-3 py-2 text-xs">
                        {issue.resolvedOn.join(", ") || "-"}
                        {issue.missingFrom.length > 0 ? ` (- ${issue.missingFrom.join(", ")})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {m.windowsHeading}
        </h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">{m.windowsNote}</p>

        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase text-zinc-500">{m.p1Heading}</dt>
            <dd className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              {fill(m.p1Reached, {
                count: initial.windows.p1.consecutiveOk,
                total: initial.windows.p1.windowSlots,
              })}
              {initial.windows.p1.met ? ` ${m.p1Met}` : null}
              {initial.windows.p1.brokenAt === null ? null : (
                <span className="block text-xs text-zinc-500">
                  {fill(m.p1Broken, {
                    slot: initial.windows.p1.brokenAt.slot,
                    state: initial.windows.p1.brokenAt.state,
                  })}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase text-zinc-500">{m.p2Heading}</dt>
            <dd className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              {initial.windows.p2.verdict === "insufficient_evidence"
                ? fill(m.p2Insufficient, { total: initial.windows.p2.windowSlots })
                : fill(m.p2Counted, {
                    successes: initial.windows.p2.successes,
                    observed: initial.windows.p2.observedSlots,
                    required: initial.windows.p2.minSuccesses,
                    total: initial.windows.p2.windowSlots,
                  })}
              {initial.windows.p2.verdict === "met" ? ` ${m.p2Met}` : null}
              {initial.windows.p2.verdict === "not_met" ? ` ${m.p2NotMet}` : null}
              {initial.windows.p2.duplicates > 0 ? (
                <span className="block text-xs text-amber-700 dark:text-amber-400">
                  {fill(m.p2Duplicates, { count: initial.windows.p2.duplicates })}
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
