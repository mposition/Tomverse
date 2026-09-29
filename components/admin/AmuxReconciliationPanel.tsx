"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxReconciliationMessages } from "@/lib/adminMessages/amuxReconciliation";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-reconciliation");

type ReconciliationBody = {
  outcome?: string;
  code?: string | null;
  error?: string;
  inactive?: boolean;
  applyPermitted?: boolean;
  writes?: number;
  itemDriftCount?: number;
  acceptCount?: number;
  rejectCount?: number;
  acceptKeys?: string[];
  rejectKeys?: string[];
};

export function AmuxReconciliationPanel() {
  const messages = useAdminMessages(adminAmuxReconciliationMessages);
  const [requestText, setRequestText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ReconciliationBody | null>(null);

  const send = async (action: string) => {
    setPending(true);
    try {
      const response = await adminFetch(`/api/admin/amux/reconciliation?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestText,
      });
      setResult((await response.json()) as ReconciliationBody);
    } catch {
      setResult({ error: "reconciliation_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const applyReady = result?.applyPermitted === true;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-reconciliation-panel">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h1>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-reconciliation-request">
        {messages.requestLabel}
        <textarea
          id="amux-reconciliation-request"
          className="min-h-40 w-full rounded-md border border-zinc-300 bg-white p-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={requestText}
          onChange={(event) => setRequestText(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={pending || requestText.trim().length === 0}
          onClick={() => send("preview")}
        >
          {messages.preview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || !applyReady}
          aria-describedby="amux-reconciliation-apply-reason"
          onClick={() => send("apply")}
        >
          {messages.apply}
        </button>
      </div>
      <p id="amux-reconciliation-apply-reason" className="text-sm text-zinc-700 dark:text-zinc-300">
        {applyReady ? messages.applyPermitted : messages.applyDisabled}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100" role="status">
          {result.error ? <p>{messages.error(result.error)}</p> : null}
          {result.code ? <p>{messages.error(result.code)}</p> : null}
          {result.inactive ? <p>{messages.inactive}</p> : null}
          {result.outcome === "preview" ? (
            <p>{messages.counts(result.itemDriftCount ?? 0, result.acceptCount ?? 0, result.rejectCount ?? 0)}</p>
          ) : null}
          {result.acceptKeys && result.acceptKeys.length > 0 ? <p>{result.acceptKeys.join(", ")}</p> : null}
          {result.rejectKeys && result.rejectKeys.length > 0 ? <p>{result.rejectKeys.join(", ")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
