"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxBoardImportMessages } from "@/lib/adminMessages/amuxBoardImport";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-board-import");

type PreviewBody = {
  classification?: { create: string[]; noOp: string[]; conflict: string[]; exclude: string[] };
  refusal?: string | null;
  sourceMissingCount?: number;
  sourceMissingTruncated?: boolean;
  sourceDriftCount?: number;
  activeExecutionCount?: number;
  otherConflictCount?: number;
  conflictLedger?: { key?: string; reasons?: string[] }[];
  applyPermitted?: boolean;
  approvalId?: string;
  status?: string;
  error?: string;
  code?: string;
};

function sourceMissingSentence(
  messages: {
    sourceMissingScanStopped: string;
    sourceMissingAllPresent: string;
    sourceMissing: (count: number) => string;
    sourceMissingTruncated: (count: number) => string;
  },
  result: PreviewBody,
): string | null {
  if (typeof result.sourceMissingCount !== "number") return null;
  if (result.sourceMissingTruncated && result.sourceMissingCount === 0) {
    return messages.sourceMissingScanStopped;
  }
  if (result.sourceMissingTruncated) {
    return messages.sourceMissingTruncated(result.sourceMissingCount);
  }
  if (result.sourceMissingCount === 0) return messages.sourceMissingAllPresent;
  return messages.sourceMissing(result.sourceMissingCount);
}

export function AmuxBoardImportPanel() {
  const messages = useAdminMessages(adminAmuxBoardImportMessages);
  const [manifest, setManifest] = useState("");
  const [approvalId, setApprovalId] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PreviewBody | null>(null);

  const send = async (action: string, body: string) => {
    setPending(true);
    try {
      const response = await fetch(`/api/admin/amux/board-import?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = (await response.json()) as PreviewBody;
      setResult(payload);
      if (payload.approvalId) setApprovalId(payload.approvalId);
    } catch {
      setResult({ error: "board_import_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp = result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const classification = result?.classification;

  const missingSentence = result ? sourceMissingSentence(messages, result) : null;
  const ledgerLines = (result?.conflictLedger ?? []).flatMap((entry) => {
    if (typeof entry.key !== "string" || !Array.isArray(entry.reasons)) return [];
    const reasons = entry.reasons.flatMap((code) => {
      if (code === "source_drift") return [messages.reasonSourceDrift];
      if (code === "active_execution") return [messages.reasonActiveExecution];
      if (code === "other_conflict") return [messages.reasonOtherConflict];
      return [];
    });
    if (reasons.length === 0) return [];
    return [messages.conflictLedgerLine(entry.key, reasons.join(", "))];
  });

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-board-import-panel">
      <h1 className="text-lg font-semibold text-zinc-900">{messages.title}</h1>
      <p className="text-sm text-zinc-700">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800" htmlFor="amux-board-import-manifest">
        {messages.manifestLabel}
        <textarea
          id="amux-board-import-manifest"
          className="min-h-40 w-full rounded-md border border-zinc-300 p-3 text-base text-zinc-900"
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50"
          disabled={pending || manifest.trim().length === 0}
          onClick={() => send("preview", manifest)}
        >
          {messages.preview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || manifest.trim().length === 0}
          onClick={() => send("prepare", manifest)}
        >
          {messages.prepare}
        </button>
      </div>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800" htmlFor="amux-board-import-approval">
        {messages.approvalLabel}
        <input
          id="amux-board-import-approval"
          className="min-h-11 w-full rounded-md border border-zinc-300 px-3 text-base text-zinc-900"
          value={approvalId}
          onChange={(event) => setApprovalId(event.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("approve", JSON.stringify({ approvalId }))}
        >
          {messages.approve}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("reject", JSON.stringify({ approvalId }))}
        >
          {messages.reject}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("expire", JSON.stringify({ approvalId }))}
        >
          {messages.expire}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending}
          onClick={() => send("expire-due", "{}")}
        >
          {messages.expireDue}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-500"
          disabled
          aria-describedby="amux-board-import-apply-reason"
        >
          {messages.apply}
        </button>
      </div>
      <p id="amux-board-import-apply-reason" className="text-sm text-zinc-700">
        {messages.applyDisabled}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800" role="status">
          {result.error ? <p>{messages.error(result.error)}</p> : null}
          {result.status ? <p>{messages.status(result.status)}</p> : null}
          {result.refusal ? <p>{messages.refusal(result.refusal)}</p> : null}
          {typeof result.applyPermitted === "boolean" ? (
            <p>{messages.applyPermitted(String(result.applyPermitted))}</p>
          ) : null}
          {classification ? (
            <p>
              {messages.counts(
                classification.create.length,
                classification.noOp.length,
                classification.conflict.length,
                classification.exclude.length,
              )}
            </p>
          ) : null}
          {missingSentence ? <p>{missingSentence}</p> : null}
          {typeof result.sourceDriftCount === "number" ? (
            <p>{messages.sourceDrift(result.sourceDriftCount)}</p>
          ) : null}
          {typeof result.activeExecutionCount === "number" ? (
            <p>{messages.activeExecution(result.activeExecutionCount)}</p>
          ) : null}
          {typeof result.otherConflictCount === "number" ? (
            <p>{messages.otherConflict(result.otherConflictCount)}</p>
          ) : null}
          {ledgerLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
