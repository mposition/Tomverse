"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxBacklogMetadataMessages } from "@/lib/adminMessages/amuxBacklogMetadata";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-backlog?tab=metadata");

type MetadataBody = {
  valid?: boolean;
  code?: string | null;
  refusal?: string | null;
  applyPermitted?: boolean;
  status?: string;
  revision?: number;
  error?: string;
};

type PreviewFact = { text: string; valid: boolean; applyPermitted: boolean };

export function AmuxBacklogMetadataPanel() {
  const messages = useAdminMessages(adminAmuxBacklogMetadataMessages);
  const [requestText, setRequestText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<MetadataBody | null>(null);
  // Apply is bound to the exact text the latest successful preview read. Any
  // apply, failed or not, and any failed preview clear it, so a second apply
  // needs a fresh preview against the card's new revision.
  const [previewed, setPreviewed] = useState<PreviewFact | null>(null);

  const send = async (action: "preview" | "apply") => {
    const body = requestText;
    setPending(true);
    try {
      const response = await adminFetch(`/api/admin/amux/backlog-metadata?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = (await response.json()) as MetadataBody;
      setResult(payload);
      if (
        response.ok &&
        action === "preview" &&
        typeof payload.valid === "boolean" &&
        typeof payload.applyPermitted === "boolean"
      ) {
        setPreviewed({ text: body, valid: payload.valid, applyPermitted: payload.applyPermitted });
      } else {
        setPreviewed(null);
      }
    } catch {
      setPreviewed(null);
      setResult({ error: "backlog_metadata_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const applyReady =
    previewed !== null &&
    previewed.valid === true &&
    previewed.applyPermitted === true &&
    previewed.text === requestText;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-backlog-metadata-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-backlog-metadata-request">
        {messages.requestLabel}
        <textarea
          id="amux-backlog-metadata-request"
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
          aria-describedby="amux-backlog-metadata-apply-reason"
          onClick={() => send("apply")}
        >
          {messages.apply}
        </button>
      </div>
      <p id="amux-backlog-metadata-apply-reason" className="text-sm text-zinc-700 dark:text-zinc-300">
        {applyReady
          ? messages.applyPermitted("true")
          : previewed?.applyPermitted === false
            ? messages.applyDisabled
            : messages.applyWaiting}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100" role="status">
          {result.error ? <p>{messages.error(result.error)}</p> : null}
          {result.code && result.code !== "ADMIN_REAUTHENTICATION_REQUIRED" ? <p>{messages.code(result.code)}</p> : null}
          {result.refusal ? <p>{messages.refusal(result.refusal)}</p> : null}
          {typeof result.valid === "boolean" ? <p>{messages.valid(result.valid ? "true" : "false")}</p> : null}
          {typeof result.applyPermitted === "boolean" ? (
            <p>{messages.applyPermitted(result.applyPermitted ? "true" : "false")}</p>
          ) : null}
          {result.status ? <p>{messages.status(result.status)}</p> : null}
          {typeof result.revision === "number" ? <p>{messages.revision(result.revision)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
