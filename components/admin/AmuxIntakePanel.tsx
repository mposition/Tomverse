"use client";

import { useRef, useState } from "react";
import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIntakeMessages } from "@/lib/adminMessages/amuxIntake";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminFetch } from "@/lib/adminFetch";
import { confirmAmuxIntakePreview } from "./amuxIntakeConfirmation";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-u21-test-card");

type IntakeBody = {
  outcome?: string;
  code?: string | null;
  error?: string;
  unitCount?: number;
  inactive?: boolean;
  applyPermitted?: boolean;
  writes?: number;
  retry?: boolean;
  readBack?: string;
  reconfirmRequired?: boolean;
  title?: string | null;
  scope?: string | null;
  completion?: string | null;
  priority?: string | null;
  sourceVersion?: string | null;
  sourceDigest?: string | null;
  draftDigest?: string | null;
  cardId?: string;
};

export function AmuxIntakePanel() {
  const messages = useAdminMessages(adminAmuxIntakeMessages);
  const [requestText, setRequestText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<IntakeBody | null>(null);
  const [previewedText, setPreviewedText] = useState<string | null>(null);
  const inFlight = useRef(false);
  const terminal = useRef(false);

  const send = async (action: string, bodyText = requestText) => {
    if (inFlight.current || terminal.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const response = await adminFetch(`/api/admin/amux/intake?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      });
      const body = (await response.json()) as IntakeBody;
      const ambiguous = action === "register" &&
        (response.status >= 500 || body.retry === false || (response.ok && !body.cardId));
      if (action === "register" && (ambiguous || !!body.cardId)) terminal.current = true;
      setPreviewedText(bodyText);
      setResult(ambiguous ? {
        ...body,
        code: body.code ?? (body.error === "outcome_unknown" ? undefined : body.error),
        error: "outcome_unknown",
      } : body);
    } catch {
      // A register request may have committed before its reply was lost.
      if (action === "register") terminal.current = true;
      setPreviewedText(bodyText);
      setResult({ error: action === "register" ? "outcome_unknown" : "intake_failed" });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const confirm = () => {
    if (!result) return;
    const confirmed = confirmAmuxIntakePreview(requestText,
      previewedText, result);
    if (!confirmed) return;
    setRequestText(confirmed);
    setResult(null);
    setPreviewedText(null);
    void send("preview", confirmed);
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  // An ambiguous write needs exact read-back, never an in-page resubmit.
  const locked = result?.error === "outcome_unknown" || !!result?.cardId;
  const registerReady = previewedText === requestText &&
    result?.outcome === "allow" && result.applyPermitted === true;
  const confirmReady = result !== null &&
    confirmAmuxIntakePreview(requestText, previewedText, result) !== null;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-intake-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-intake-request">
        {messages.requestLabel}
        <textarea
          id="amux-intake-request"
          className="min-h-40 w-full rounded-md border border-zinc-300 bg-white p-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={requestText}
          disabled={pending || locked}
          onChange={(event) => { setRequestText(event.target.value);
            setResult(null); setPreviewedText(null); }}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={pending || locked || requestText.trim().length === 0}
          onClick={() => send("preview")}
        >
          {messages.preview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || locked || !confirmReady}
          onClick={confirm}
        >
          {messages.confirmPreview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || locked || !registerReady}
          aria-describedby="amux-intake-register-reason"
          onClick={() => send("register")}
        >
          {messages.register}
        </button>
      </div>
      <p id="amux-intake-register-reason" className="text-sm text-zinc-700 dark:text-zinc-300">
        {registerReady ? messages.registerPermitted : messages.registerDisabled}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100" role="status">
          {result.error === "outcome_unknown" ? <p>{messages.outcomeUnknown}</p> : null}
          {result.error === "outcome_unknown" && result.readBack === "absent" ?
            <p>{messages.readBackAbsent}</p> : null}
          {result.error === "outcome_unknown" && result.readBack === "partial" ?
            <p>{messages.readBackPartial}</p> : null}
          {result.error === "outcome_unknown" ? (
            <Link className="font-medium underline" href="/admin/amux-execution?tab=cards">
              {messages.inspectCards}
            </Link>
          ) : null}
          {result.error && result.error !== "outcome_unknown" ? <p>{messages.error(result.error)}</p> : null}
          {result.code ? <p>{messages.error(result.code)}</p> : null}
          {result.inactive ? <p>{messages.inactive}</p> : null}
          {result.reconfirmRequired ? <p>{messages.reconfirm}</p> : null}
          {result.unitCount === 1 && result.title ? <p>{messages.unit(result.title)}</p> : null}
          {result.unitCount === 1 && result.scope ? <p>{messages.scope(result.scope)}</p> : null}
          {result.unitCount === 1 && result.completion ? <p>{messages.completion(result.completion)}</p> : null}
          {result.unitCount === 1 && result.priority ? <p>{messages.priority(result.priority)}</p> : null}
          {result.unitCount === 1 && result.sourceVersion ? <p>{messages.sourceVersion(result.sourceVersion)}</p> : null}
          {result.unitCount === 1 && result.sourceDigest ? <p>{messages.sourceDigest(result.sourceDigest)}</p> : null}
          {result.cardId ? (
            <p>
              <a className="font-medium underline" href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(result.cardId)}`}>
                {result.cardId}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
