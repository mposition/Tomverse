"use client";

import { useState, type ReactNode } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

/** Which card stands in for the locked idea input (approved backlog
 * redesign, state cards): checking, unknown, saved and receipt-locked. Each
 * says why the input is locked, names the request id and offers the next
 * action; nothing here writes or retries a request. */
export type AmuxIdeaRequestCardState =
  | { kind: "checking"; requestId: string }
  | { kind: "unknown"; requestId: string }
  | { kind: "saved"; requestId: string; ideaId: string }
  | { kind: "locked" };

const tone = {
  checking: "border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/30",
  unknown: "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30",
  saved: "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950",
  locked: "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30",
} as const;

export function AmuxIdeaRequestStatusCard({ state, children }: {
  state: AmuxIdeaRequestCardState;
  /** The card's own actions, rendered under its explanation. */
  children?: ReactNode;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [copied, setCopied] = useState(false);
  const requestId = state.kind === "locked" ? null : state.requestId;
  const copy = async () => {
    if (!requestId) return;
    try { await navigator.clipboard.writeText(requestId); setCopied(true); } catch { setCopied(false); }
  };
  const title = state.kind === "checking" ? m.statusCheckingTitle :
    state.kind === "unknown" ? m.statusUnknownTitle :
      state.kind === "saved" ? m.statusSavedTitle : m.statusLockedTitle;
  const body = state.kind === "checking" ? m.statusCheckingBody :
    state.kind === "unknown" ? m.statusUnknownBody :
      state.kind === "saved" ? m.statusSavedBody : m.recoveryUnavailable;
  return (
    <section className={`space-y-3 rounded-xl border p-4 text-sm ${tone[state.kind]}`}
      role={state.kind === "unknown" || state.kind === "locked" ? "alert" : "status"}
      data-testid="amux-idea-request-status" data-state={state.kind}>
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      <p className="text-zinc-700 dark:text-zinc-300">{body}</p>
      {requestId ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <span>{m.statusRequestId}</span>
          <code className="break-all font-mono text-zinc-800 dark:text-zinc-200">{requestId}</code>
          <button type="button" onClick={() => void copy()}
            className="min-h-11 rounded border border-zinc-300 px-2 dark:border-zinc-700">
            {copied ? m.statusCopied : m.statusCopy}
          </button>
        </p>
      ) : null}
      {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
    </section>
  );
}
