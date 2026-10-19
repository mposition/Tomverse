"use client";

import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const PAGE_PATH = "/admin/support?tab=feedback";
const ROUTE = "/api/admin/support-triage/llm-model";

type Option = { id: string; name: string; provider: string };

/**
 * Which model the support-triage LLM step uses. Saving needs the owner and a
 * recent sign-in; a stale sign-in is answered with the way back. "Off" clears
 * the choice, and the environment variable applies again if it is set.
 */
export function SupportTriageModelPanel() {
  const m = useAdminMessages(adminFeedbackInboxMessages);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await adminFetch(ROUTE);
        const payload = (await response.json()) as { modelId?: string | null; options?: Option[] };
        if (!live) return;
        if (!response.ok || !Array.isArray(payload.options)) {
          setNotice({ tone: "error", text: m.triageModelLoadFailed });
          return;
        }
        setOptions(payload.options);
        setSaved(payload.modelId ?? null);
        setChoice(payload.modelId ?? "");
      } catch {
        if (live) setNotice({ tone: "error", text: m.triageModelLoadFailed });
      }
    })();
    return () => {
      live = false;
    };
  }, [m.triageModelLoadFailed]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    setReauthenticationRequired(false);
    try {
      const response = await adminFetch(ROUTE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: choice === "" ? null : choice }),
      });
      const payload = (await response.json().catch(() => ({}))) as { code?: unknown; modelId?: string | null };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (!response.ok) {
        setNotice({ tone: "error", text: response.status === 403 ? m.triageModelOwnerOnly : m.triageModelSaveFailed });
        return;
      }
      setSaved(payload.modelId ?? null);
      setNotice({ tone: "ok", text: m.triageModelSaved });
    } catch {
      setNotice({ tone: "error", text: m.triageModelSaveFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4"
      data-testid="support-triage-model-panel"
      aria-labelledby="support-triage-model-title"
    >
      <h2 id="support-triage-model-title" className="text-sm font-bold text-white">
        {m.triageModelTitle}
      </h2>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{m.triageModelHelp}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="support-triage-model-select">
          {m.triageModelTitle}
        </label>
        <select
          id="support-triage-model-select"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          disabled={options === null || busy}
          className="min-h-11 min-w-64 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
        >
          <option value="">{m.triageModelOff}</option>
          {(options ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({option.provider})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void save()}
          disabled={options === null || busy || choice === (saved ?? "")}
          className="min-h-11 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 text-sm font-bold text-blue-100 transition hover:bg-blue-500/20 disabled:opacity-50"
        >
          {m.triageModelSave}
        </button>
      </div>
      {reauthenticationRequired ? (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.triageModelReauthenticate}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.triageModelSignInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={`mt-2 text-sm ${notice.tone === "ok" ? "text-zinc-200" : "text-red-300"}`}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
