"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { adminEngineeringAgentMessages } from "@/lib/adminMessages/engineeringAgent";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type {
  EngineeringAgentConsolePayload,
  EngineeringAgentOwnerItemView,
} from "@/lib/engineeringAgentConsoleRead";
import { adminFetch } from "@/lib/adminFetch";

/** Where a step-up brings the operator back to: the tab (and view) the section is on. */
const returnPathFor = (section: string) =>
  section === "pull-requests"
    ? "/admin/engineering-agent?tab=runs&view=pull-requests"
    : `/admin/engineering-agent?tab=${section}`;

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
      const response = await adminFetch(url, {
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

  const rejudge = (item: EngineeringAgentOwnerItemView) => {
    if (!item.patchDigest || !item.baseSha) return;
    if (!window.confirm(m.confirmRejudge)) return;
    void post(`${item.id}:rejudge`, "/api/admin/engineering-agent/rejudge", {
      workItemId: item.id,
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
            ? "border-red-800 text-red-300"
            : "border-zinc-700 text-zinc-200",
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
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Lock className="h-4 w-4" aria-hidden="true" />
          {m.readOnlyNote}
        </p>
      ) : null}

      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(returnPathFor(initial.section))}>
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

      {initial.queue ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-300">
            {fill(m.totals, {
              t2: initial.queue.totals.t2_draft,
              decision: initial.queue.totals.decision,
              mismatch: initial.queue.totals.state_mismatch,
            })}{" "}
            {fill(m.showingOldest, { count: initial.limit })}
          </p>
          {initial.queue.items.length === 0 ? <p className="text-sm text-zinc-400">{m.emptyQueue}</p> : null}
          <ul className="flex flex-col gap-3">
            {initial.queue.items.map((item) => (
              <li key={item.id} className="rounded-lg border p-4 border-zinc-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-zinc-100">{kindLabel(item.kind)}</p>
                  <p className="text-xs text-zinc-500">{item.createdAt}</p>
                </div>
                <OwnerItemContext item={item} />
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-zinc-400">{m.contextTechnical}</summary>
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
                </details>
                {item.patchBody !== null ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium">{m.patch}</summary>
                    <pre className="mt-2 max-h-96 overflow-auto rounded p-3 text-xs bg-zinc-900">
                      {item.patchBody}
                    </pre>
                  </details>
                ) : null}
                {item.kind === "state_mismatch" ? (
                  <p className="mt-2 text-sm text-zinc-400">{m.mismatchNote}</p>
                ) : null}
                {item.kind !== "decision" ? (
                  <div className="mt-3 text-sm">
                    <p className="font-medium text-zinc-200">{m.contextActions}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-400">
                      {(item.kind === "t2_draft"
                        ? [...m.actionsT2, ...(item.rejudgeable ? [m.actionRejudge] : [])]
                        : m.actionsMismatch.filter((_, index) => index !== 1 || item.causeKey.startsWith("review_pr:"))
                      ).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {initial.canWrite && item.kind === "t2_draft" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {button(`${item.id}:approved`, m.approve, () => decide(item, "approved"), "primary")}
                    {button(`${item.id}:rejected`, m.reject, () => decide(item, "rejected"), "danger")}
                    {item.rejudgeable ? button(`${item.id}:rejudge`, m.rejudge, () => rejudge(item)) : null}
                  </div>
                ) : null}
                {initial.canWrite && item.kind === "state_mismatch" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {button(`${item.id}:close`, m.mismatchClose, () => {
                      if (!window.confirm(m.confirmMismatchClose)) return;
                      void post(`${item.id}:close`, "/api/admin/engineering-agent/mismatches", {
                        workItemId: item.id,
                        action: "close_domain_after_verified_no_write",
                      });
                    })}
                    {item.causeKey.startsWith("review_pr:")
                      ? button(`${item.id}:merged`, m.mismatchCloseMerged, () => {
                          if (!window.confirm(m.confirmMismatchCloseMerged)) return;
                          void post(`${item.id}:merged`, "/api/admin/engineering-agent/mismatches", {
                            workItemId: item.id,
                            action: "close_after_observed_merge",
                          });
                        })
                      : null}
                    {item.causeKey.startsWith("review_pr:")
                      ? button(`${item.id}:record-pr`, m.mismatchRecordReviewPr, () => {
                          if (!window.confirm(m.confirmMismatchRecordReviewPr)) return;
                          void post(`${item.id}:record-pr`, "/api/admin/engineering-agent/mismatches", {
                            workItemId: item.id,
                            action: "record_bound_review_pr",
                          });
                        })
                      : null}
                    {button(`${item.id}:leave`, m.mismatchLeaveOpen, () =>
                      void post(`${item.id}:leave`, "/api/admin/engineering-agent/mismatches", {
                        workItemId: item.id,
                        action: "leave_open",
                      }),
                    )}
                    {button(`${item.id}:off`, m.mismatchModeOff, () =>
                      void post(`${item.id}:off`, "/api/admin/engineering-agent/mismatches", {
                        workItemId: item.id,
                        action: "mode_off",
                      }),
                    )}
                    {button(
                      `${item.id}:escalate`,
                      m.mismatchEscalate,
                      () => {
                        if (!window.confirm(m.confirmMismatchEscalate)) return;
                        void post(`${item.id}:escalate`, "/api/admin/engineering-agent/mismatches", {
                          workItemId: item.id,
                          action: "escalate_incident",
                        });
                      },
                      "danger",
                    )}
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
          <p className="text-sm text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
          <AdminDataTable
            caption={m.run}
            rows={initial.runs}
            rowKey={(run) => run.id}
            emptyState={<AdminStateBlock kind="empty" title={m.emptyRuns} />}
            columns={[
              { key: "run", header: m.run, render: (run) => <span className="font-mono text-xs">{run.id}</span> },
              { key: "card", header: m.card, render: (run) => <span className="font-mono text-xs">{run.cardId}</span> },
              { key: "mode", header: m.modeAtStart, render: (run) => run.modeAtStart },
              { key: "status", header: m.status, render: (run) => run.status },
              { key: "outcome", header: m.outcome, render: (run) => run.outcome ?? "" },
              { key: "halt", header: m.halt, render: (run) => run.halt },
              { key: "started", header: m.started, render: (run) => formatAestDateTime(run.startedAt) ?? "" },
              { key: "ended", header: m.ended, render: (run) => formatAestDateTime(run.endedAt) ?? "" },
            ]}
            cardTitle={(run) => <span className="font-mono text-xs">{run.id}</span>}
            // The phone card keeps every fact the table has: card, mode, halt and both times.
            cardMeta={(run) =>
              [
                run.status,
                run.outcome,
                run.cardId,
                run.modeAtStart,
                run.halt,
                formatAestDateTime(run.startedAt),
                formatAestDateTime(run.endedAt),
              ]
                .filter((part): part is string => typeof part === "string" && part !== "")
                .join(" · ")
            }
          />
        </div>
      ) : null}

      {initial.pullRequests ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-400">{fill(m.showingNewest, { count: initial.limit })}</p>
          <AdminDataTable
            caption={m.pullRequest}
            rows={initial.pullRequests}
            rowKey={(row) => row.id}
            emptyState={<AdminStateBlock kind="empty" title={m.emptyPullRequests} />}
            columns={[
              { key: "pr", header: m.pullRequest, render: (row) => <span className="font-mono text-xs">#{row.prNumber}</span> },
              { key: "run", header: m.run, render: (row) => <span className="font-mono text-xs">{row.runId}</span> },
              { key: "state", header: m.state, render: (row) => row.state },
              { key: "current", header: m.current, render: (row) => (row.current ? m.current : m.superseded) },
              { key: "approval", header: m.approval, render: (row) => row.approvalVerdict ?? m.notObserved },
              {
                key: "merged",
                header: m.merged,
                render: (row) => (row.merged === null ? m.notObserved : row.merged ? m.yes : m.no),
              },
            ]}
            cardTitle={(row) => <span className="font-mono text-xs">#{row.prNumber}</span>}
            // The phone card keeps the run, whether it is the current binding, the approval and the merge reading.
            cardMeta={(row) =>
              [
                row.state,
                row.runId,
                row.current ? m.current : m.superseded,
                row.approvalVerdict ?? m.notObserved,
                `${m.merged}: ${row.merged === null ? m.notObserved : row.merged ? m.yes : m.no}`,
              ].join(" · ")
            }
          />
        </div>
      ) : null}

      {initial.settings ? (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500">{m.mode}</dt>
            <dd className="font-mono">{initial.settings.mode}</dd>
            <dt className="text-zinc-500">{m.freeze}</dt>
            <dd>{initial.settings.frozen ? m.on : m.off}</dd>
            <dt className="text-zinc-500">{m.killSwitch}</dt>
            <dd>{initial.settings.killSwitch ? m.engaged : m.notEngaged}</dd>
          </dl>
          <p className="text-sm text-zinc-300">
            {fill(m.prQueue, {
              occupied: initial.settings.pullRequests.occupied,
              limit: initial.settings.pullRequests.limit,
            })}
            <br />
            {fill(m.decisionQueue, {
              occupied: initial.settings.decisions.occupied,
              limit: initial.settings.decisions.limit,
            })}
          </p>
          <p className="text-sm text-zinc-400">{m.queueNote}</p>
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
              {button("halt:ack", m.acknowledgeHalt, () =>
                void post("halt:ack", "/api/admin/engineering-agent/halt", {}),
              )}
              {button("monitors:confirm", m.confirmMonitors, () =>
                void post("monitors:confirm", "/api/admin/engineering-agent/monitors", {}),
              )}
            </div>
          ) : null}
          <p className="text-sm text-zinc-400">{m.haltNote}</p>
          <p className="text-sm text-zinc-400">{m.t1Note}</p>
        </div>
      ) : null}
    </section>
  );
}

const PR_BASE_URL = "https://github.com/mposition/Tomverse/pull/";

/**
 * What a person needs beside an owner item to decide it: the card and run it
 * is about, why it waits, the pull request it touches, the files the draft
 * changes, and who reviewed it -- the cross-vendor review and the Decision
 * Maker. Reads only; nothing here acts.
 */
function OwnerItemContext({ item }: { item: EngineeringAgentOwnerItemView }) {
  const m = useAdminMessages(adminEngineeringAgentMessages);
  const context = item.context;
  const why = item.reason ? (m.reasonText[item.reason] ?? null) : null;
  return (
    <div className="mt-2 flex flex-col gap-3 text-sm">
      {context ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-zinc-500">{m.contextCard}</dt>
          <dd className="min-w-0">
            <Link
              className="font-medium text-zinc-100 underline-offset-2 hover:underline"
              href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(context.card.id)}`}
            >
              {context.card.displayKey ? `${context.card.displayKey} · ` : ""}
              {context.card.title ?? m.contextUntitled}
            </Link>
            <span className="ml-2 text-xs text-zinc-500">
              {fill(m.contextCardStatus, { status: context.card.status })}
              {context.card.taskRole ? ` · ${fill(m.contextRole, { role: context.card.taskRole })}` : ""}
            </span>
          </dd>
          <dt className="text-zinc-500">{m.contextRun}</dt>
          <dd>
            {fill(m.contextRunLine, {
              status: context.run.outcome ? `${context.run.status}/${context.run.outcome}` : context.run.status,
              worker: context.run.worker,
              attempt: context.run.attemptOutcome ?? "-",
            })}
            <span className="ml-2 text-xs text-zinc-500">{formatAestDateTime(context.run.startedAt)}</span>
          </dd>
          <dt className="text-zinc-500">{m.contextPullRequests}</dt>
          <dd>
            {context.pullRequests.length === 0
              ? m.contextNoPullRequest
              : context.pullRequests.map((pr) => (
                  <span key={pr.prNumber} className="mr-3 inline-block">
                    <a
                      className="font-mono underline-offset-2 hover:underline"
                      href={`${PR_BASE_URL}${pr.prNumber}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{pr.prNumber}
                    </a>{" "}
                    <span className="text-zinc-400">
                      {pr.merged ? m.contextPrMerged : m.contextPrOpen}
                      {pr.approvalVerdict === "approved" ? ` · ${m.contextPrApproved}` : ""}
                    </span>
                  </span>
                ))}
          </dd>
        </dl>
      ) : (
        <p className="text-zinc-400">{m.contextNoRun}</p>
      )}

      {item.reason ? (
        <div>
          <p className="font-medium text-zinc-200">{m.contextWhy}</p>
          <p className="mt-1 text-zinc-300">
            {why ?? item.reason} <span className="font-mono text-xs text-zinc-500">({item.reason})</span>
          </p>
        </div>
      ) : null}

      {context && context.fileCount > 0 ? (
        <div>
          <p className="font-medium text-zinc-200">{fill(m.contextFiles, { count: context.fileCount })}</p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs">
            {context.files.map((file) => (
              <li key={file.path} className="break-all">
                <span className="text-emerald-400">+{file.added}</span>{" "}
                <span className="text-red-400">-{file.removed}</span> {file.path}
              </li>
            ))}
          </ul>
          {context.fileCount > context.files.length ? (
            <p className="text-xs text-zinc-500">
              {fill(m.contextFilesMore, { count: context.fileCount - context.files.length })}
            </p>
          ) : null}
        </div>
      ) : null}

      {context ? (
        <div>
          <p className="font-medium text-zinc-200">{m.contextReview}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-zinc-500">{m.contextCrossReview}</dt>
            <dd>
              {context.review
                ? `${fill(m.contextCrossReviewLine, {
                    verdict: context.review.verdict,
                    author: context.review.authorVendor,
                    reviewers: context.review.reviewerVendors.join(", ") || "-",
                  })}${context.review.touchesContract ? ` · ${m.contextTouchesContract}` : ""}`
                : m.contextNoCrossReview}
            </dd>
            <dt className="text-zinc-500">{m.contextDm}</dt>
            <dd>
              {context.dm.filed ? (
                <>
                  <p>
                    {fill(m.contextDmFiled, {
                      kind: context.dm.kind,
                      state: context.dm.state,
                      decision: context.dm.decision ?? m.contextDmPending,
                    })}
                  </p>
                  <p className="text-zinc-400">{m.dmStates[context.dm.detail.state] ?? context.dm.detail.state}</p>
                  {context.dm.detail.state === "proposal" ? (
                    <div className="mt-1">
                      <p className="text-zinc-500">{m.contextDmRationale}</p>
                      <p className="whitespace-pre-wrap break-words">{context.dm.detail.rationale}</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-zinc-400">{m.contextDmNotFiled}</p>
              )}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
