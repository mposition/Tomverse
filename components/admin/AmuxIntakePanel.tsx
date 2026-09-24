"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIntakeMessages } from "@/lib/adminMessages/amuxIntake";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-intake");

type IntakeBody = {
  outcome?: string;
  code?: string | null;
  error?: string;
  unitCount?: number;
  inactive?: boolean;
  applyPermitted?: boolean;
  writes?: number;
  reconfirmRequired?: boolean;
  title?: string | null;
  scope?: string | null;
  completion?: string | null;
  priority?: string | null;
  sourceVersion?: string | null;
  sourceDigest?: string | null;
};

export function AmuxIntakePanel() {
  const messages = useAdminMessages(adminAmuxIntakeMessages);
  const [requestText, setRequestText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<IntakeBody | null>(null);

  const send = async (action: string) => {
    setPending(true);
    try {
      const response = await fetch(`/api/admin/amux/intake?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestText,
      });
      setResult((await response.json()) as IntakeBody);
    } catch {
      setResult({ error: "intake_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const registerReady = result?.applyPermitted === true;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-intake-panel">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h1>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-intake-request">
        {messages.requestLabel}
        <textarea
          id="amux-intake-request"
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
          disabled={pending || !registerReady}
          aria-describedby="amux-intake-register-reason"
          onClick={() => send("register")}
        >
          {messages.register}
        </button>
      </div>
      <p id="amux-intake-register-reason" className="text-sm text-zinc-700 dark:text-zinc-300">
        {registerReady ? messages.inactive : messages.registerDisabled}
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
          {result.reconfirmRequired ? <p>{messages.reconfirm}</p> : null}
          {result.unitCount === 1 && result.title ? <p>{messages.unit(result.title)}</p> : null}
          {result.unitCount === 1 && result.scope ? <p>{messages.scope(result.scope)}</p> : null}
          {result.unitCount === 1 && result.completion ? <p>{messages.completion(result.completion)}</p> : null}
          {result.unitCount === 1 && result.priority ? <p>{messages.priority(result.priority)}</p> : null}
          {result.unitCount === 1 && result.sourceVersion ? <p>{messages.sourceVersion(result.sourceVersion)}</p> : null}
          {result.unitCount === 1 && result.sourceDigest ? <p>{messages.sourceDigest(result.sourceDigest)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
