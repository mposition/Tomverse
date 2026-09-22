"use client";

import { useState } from "react";

import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-board-import");

type PreviewBody = {
  classification?: { create: string[]; noOp: string[]; conflict: string[]; exclude: string[] };
  refusal?: string | null;
  applyPermitted?: boolean;
  approvalId?: string;
  status?: string;
  error?: string;
  code?: string;
};

export function AmuxBoardImportPanel() {
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

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-board-import-panel">
      <h1 className="text-lg font-semibold text-zinc-900">AMUX catalog import</h1>
      <p className="text-sm text-zinc-700">
        Preview reads the catalog and writes nothing. Prepare, approve, reject and expire record an approval.
        Apply stays off until a separate production approval. This screen cannot turn it on.
      </p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800" htmlFor="amux-board-import-manifest">
        Catalog manifest
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
          Preview
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || manifest.trim().length === 0}
          onClick={() => send("prepare", manifest)}
        >
          Prepare
        </button>
      </div>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800" htmlFor="amux-board-import-approval">
        Approval id
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
          Approve
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("reject", JSON.stringify({ approvalId }))}
        >
          Reject
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending || approvalId.trim().length === 0}
          onClick={() => send("expire", JSON.stringify({ approvalId }))}
        >
          Expire
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50"
          disabled={pending}
          onClick={() => send("expire-due", "{}")}
        >
          Expire due
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-500"
          disabled
          aria-describedby="amux-board-import-apply-reason"
        >
          Apply
        </button>
      </div>
      <p id="amux-board-import-apply-reason" className="text-sm text-zinc-700">
        Apply is disabled. The server refuses it even if this control is bypassed.
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline" href={STEP_UP_HREF}>
          Renew administrator sign-in
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800" role="status">
          {result.error ? <p>Error: {result.error}</p> : null}
          {result.status ? <p>Status: {result.status}</p> : null}
          {result.refusal ? <p>Refusal: {result.refusal}</p> : null}
          {typeof result.applyPermitted === "boolean" ? <p>Apply permitted: {String(result.applyPermitted)}</p> : null}
          {classification ? (
            <p>
              Create {classification.create.length}, no-op {classification.noOp.length}, conflict{" "}
              {classification.conflict.length}, exclude {classification.exclude.length}.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
