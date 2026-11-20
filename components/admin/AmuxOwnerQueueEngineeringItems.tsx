"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxOwnerQueueMessages } from "@/lib/adminMessages/amuxOwnerQueue";
import { adminEngineeringAgentMessages } from "@/lib/adminMessages/engineeringAgent";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  engineeringAgentDecisionRequest,
  engineeringAgentMismatchRequest,
  engineeringAgentRejudgeRequest,
  postEngineeringAgentAction,
  type EngineeringAgentActionRequest,
} from "@/lib/engineeringAgentAdminAction";
import {
  ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX,
  type EngineeringAgentCardItemView,
} from "@/lib/engineeringAgentOwnerItemContextCore";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

/** The buttons an item offers a viewer; none without engineering write access. */
export const amuxOwnerQueueEngineeringButtons = (
  item: EngineeringAgentCardItemView,
  canWrite: boolean,
): Array<"approve" | "reject" | "rejudge" | "record_pr"> => {
  if (!canWrite) return [];
  if (item.kind === "t2_draft") {
    if (!item.patchDigest || !item.baseSha) return [];
    return item.rejudgeable ? ["approve", "reject", "rejudge"] : ["approve", "reject"];
  }
  return item.causeKey.startsWith(ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX) ? ["record_pr"] : [];
};

type Notice = { tone: "ok" | "error"; text: string } | null;

/**
 * The engineering agent's open items on an owner queue card (T2 drafts and
 * state mismatches), so the owner decides them on the card instead of in
 * Admin › Engineering › Decisions. Every button posts to the same engineering
 * route the console uses, with the console's confirmation words; the route
 * checks write access, a recent sign-in, the digest, the lock and the audit.
 * After a recorded action the card is read again (`onChanged`).
 */
export function AmuxOwnerQueueEngineeringItems({
  items, canWrite, reauthReturnPath, onChanged,
}: {
  items: EngineeringAgentCardItemView[];
  /** `engineering-agent:write`; a reader is not offered buttons that can only refuse. */
  canWrite: boolean;
  reauthReturnPath: string;
  onChanged: () => void;
}) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  const m = useAdminMessages(adminEngineeringAgentMessages);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  if (items.length === 0) return null;

  const send = async (key: string, confirmText: string, request: EngineeringAgentActionRequest | null) => {
    if (request === null || !window.confirm(confirmText)) return;
    setBusy(key);
    setNotice(null);
    try {
      const result = await postEngineeringAgentAction(request);
      if (result.kind === "requiresReauthentication") setReauthenticationRequired(true);
      else if (result.kind === "refused") setNotice({ tone: "error", text: fill(m.refused, { code: result.code }) });
      else if (result.kind === "failed") setNotice({ tone: "error", text: m.failed });
      else {
        setNotice({ tone: "ok", text: m.done });
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  };

  const button = (key: string, label: string, onClick: () => void, tone: "primary" | "danger" | "plain" = "plain") => (
    <button key={key} type="button" disabled={busy !== null} onClick={onClick}
      data-testid={`amux-owner-queue-engineering-${key.slice(key.indexOf(":") + 1)}`}
      className={[
        "inline-flex min-h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50",
        tone === "primary" ? "border-blue-600 bg-blue-600 text-white"
          : tone === "danger" ? "border-red-800 text-red-300" : "border-zinc-700 text-zinc-200",
      ].join(" ")}>
      {busy === key ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4"
      data-testid="amux-owner-queue-engineering">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-zinc-100">{copy.engineering.title}</p>
        <Link href="/admin/engineering-agent?tab=queue"
          className="text-xs font-bold text-blue-300 underline-offset-2 hover:underline">
          {copy.engineering.openConsole} →
        </Link>
      </div>
      <p className="flex items-center gap-2 text-xs text-zinc-400">
        {canWrite ? null : <Lock className="h-3.5 w-3.5" aria-hidden="true" />}
        {canWrite ? copy.engineering.note : copy.engineering.readOnly}
      </p>
      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(reauthReturnPath)}>{m.signInAgain}</a>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={notice.tone === "ok" ? "text-sm text-zinc-300" : "text-sm text-red-300"}>
          {notice.text}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const why = item.reason ? (m.reasonText[item.reason] ?? item.reason) : null;
          const buttons = amuxOwnerQueueEngineeringButtons(item, canWrite);
          return (
            <li key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
              data-testid="amux-owner-queue-engineering-item" data-kind={item.kind}>
              <p className="text-sm font-semibold text-zinc-100">
                {item.kind === "t2_draft" ? m.kindT2 : m.kindMismatch}
              </p>
              {why ? (
                <p className="mt-1 text-sm text-zinc-300">
                  {why} {item.reason ? <span className="font-mono text-xs text-zinc-500">({item.reason})</span> : null}
                </p>
              ) : null}
              {item.fileCount > 0 ? (
                <div className="mt-2">
                  <p className="text-xs font-bold text-zinc-400">{fill(m.contextFiles, { count: item.fileCount })}</p>
                  <ul className="mt-1 space-y-0.5 font-mono text-xs">
                    {item.files.map((file) => (
                      <li key={file.path} className="break-all">
                        <span className="text-emerald-400">+{file.added}</span>{" "}
                        <span className="text-red-400">-{file.removed}</span> {file.path}
                      </li>
                    ))}
                  </ul>
                  {item.fileCount > item.files.length ? (
                    <p className="text-xs text-zinc-500">{fill(m.contextFilesMore, { count: item.fileCount - item.files.length })}</p>
                  ) : null}
                </div>
              ) : null}
              {item.patchBody !== null ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-300">{m.patch}</summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-900 p-3 text-xs">{item.patchBody}</pre>
                </details>
              ) : null}
              {item.kind === "t2_draft" ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-400">
                  {[...m.actionsT2, ...(item.rejudgeable ? [m.actionRejudge] : [])].map((line) => <li key={line}>{line}</li>)}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-zinc-400">{m.mismatchNote}</p>
              )}
              {buttons.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {buttons.map((kind) =>
                    kind === "approve" ? button(`${item.id}:approve`, m.approve, () =>
                      void send(`${item.id}:approve`, m.confirmApprove, engineeringAgentDecisionRequest(item, "approved")), "primary")
                    : kind === "reject" ? button(`${item.id}:reject`, m.reject, () =>
                      void send(`${item.id}:reject`, m.confirmReject, engineeringAgentDecisionRequest(item, "rejected")), "danger")
                    : kind === "rejudge" ? button(`${item.id}:rejudge`, m.rejudge, () =>
                      void send(`${item.id}:rejudge`, m.confirmRejudge, engineeringAgentRejudgeRequest(item)))
                    : button(`${item.id}:record-pr`, m.mismatchRecordReviewPr, () =>
                      void send(`${item.id}:record-pr`, m.confirmMismatchRecordReviewPr,
                        engineeringAgentMismatchRequest(item.id, "record_bound_review_pr"))))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
