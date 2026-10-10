"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxLocalIntakeMessages } from "@/lib/adminMessages/amuxLocalIntake";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

// Retained for legacy API contract coverage, not mounted in the Admin console.
const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas");

type LocalCard = {
  localId?: string;
  title?: string;
  priority?: string;
  digest?: string | null;
  outcome?: string;
  code?: string | null;
  applyPermitted?: boolean;
};

type LocalBody = {
  error?: string;
  code?: string | null;
  writes?: number;
  retry?: boolean;
  readBack?: string;
  cards?: LocalCard[];
  digest?: string | null;
  reconfirmRequired?: boolean;
};

export function AmuxLocalIntakePanel() {
  const messages = useAdminMessages(adminAmuxLocalIntakeMessages);
  const [packageText, setPackageText] = useState("");
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [result, setResult] = useState<LocalBody | null>(null);

  const send = async (path: string) => {
    setPending(true);
    try {
      const response = await adminFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: packageText,
      });
      const body = (await response.json()) as LocalBody;
      setResult(body);
      if (body.error === "outcome_unknown" || body.retry === false) setBlocked(true);
    } catch {
      setResult({ error: "intake_failed" });
    } finally {
      setPending(false);
    }
  };

  const downloadSnapshot = async () => {
    setPending(true);
    try {
      const response = await adminFetch("/api/admin/amux/intake?action=local-snapshot");
      const body = await response.json();
      if (!response.ok) {
        setResult(body as LocalBody);
        return;
      }
      const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "amux-local-intake-snapshot.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setResult({ error: "intake_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const registerReady = (result?.cards ?? []).some((card) => card.applyPermitted === true);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-local-intake-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.backlogMeaning}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.perCard}</p>
      <label className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100" htmlFor="amux-local-intake-package">
        {messages.draftLabel}
        <textarea
          id="amux-local-intake-package"
          className="min-h-40 w-full rounded-md border border-zinc-300 bg-white p-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={packageText}
          onChange={(event) => {
            setPackageText(event.target.value);
            setResult(null);
            setBlocked(false);
          }}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending}
          onClick={() => void downloadSnapshot()}
        >
          {messages.snapshot}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={pending || packageText.trim().length === 0}
          onClick={() => void send("/api/admin/amux/intake?action=local-preview")}
        >
          {messages.preview}
        </button>
      </div>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {registerReady ? messages.registerPermitted : messages.registerDisabled}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result?.error === "outcome_unknown" ? <p role="status">{messages.outcomeUnknown}</p> : null}
      {result?.error === "apply_disabled" ? <p role="status">{messages.inactive}</p> : null}
      {result?.error && result.error !== "outcome_unknown" ? <p role="status">{messages.error(result.error)}</p> : null}
      {result?.code ? <p role="status">{messages.error(result.code)}</p> : null}
      <ul className="flex flex-col gap-3">
        {(result?.cards ?? []).map((card) => (
          <li key={card.localId} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
            <p className="text-sm text-zinc-900 dark:text-zinc-100">
              {messages.cardLine(card.localId ?? "", card.title ?? "", card.priority ?? "")}
            </p>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.notRegistered}</p>
            {card.code ? <p className="text-sm">{messages.error(card.code)}</p> : null}
            <button
              type="button"
              className="mt-2 min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
              disabled={pending || blocked || !card.digest || card.outcome === "reject"}
              onClick={() =>
                void send(
                  `/api/admin/amux/intake?action=local-register&localId=${encodeURIComponent(card.localId ?? "")}&confirmationDigest=${encodeURIComponent(card.digest ?? "")}`,
                )
              }
            >
              {messages.register}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
