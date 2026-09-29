"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { discardResponseBody } from "@/lib/discardResponseBody";
import {
  CONSENT_COPY_LANGUAGES,
  consentCopy,
  type ConsentCopyKey,
  type ConsentCopyLanguage,
} from "@/lib/emailConsentCopy";

/**
 * The one-time in-product question to existing accounts (S8, draft section
 * 5.4): would you like product news by email?
 *
 * Three answers, three facts, as the approved wording lays them out:
 *
 * - **Yes** requests a confirmation for each purpose the wording names
 *   (product updates, newsletters, promotions), then opens the email settings
 *   where they show as waiting. Nothing is consent until each link is used.
 * - **No, thank you** is an objection, recorded against the mailbox. If it
 *   cannot be recorded, the notice stays open and says so: a refusal that
 *   silently became a dismissal is the failure this screen must not have.
 * - **Not now** closes it. The render was recorded when it appeared, which is
 *   what keeps it from coming back; closing adds nothing.
 *
 * Asked only where the server says so (`/api/user/consent-notice`), and never
 * on top of another open dialog. The three controls carry the same size and
 * weight (device D, docs/policy/email-consent-copy-draft.md section 3.D).
 */
const NOTICE_KEYS: ConsentCopyKey[] = [
  "noticeTitle",
  "noticeBody",
  "noticeAccept",
  "noticeRefuse",
  "noticeDismiss",
];

const answerButtonClass =
  "min-h-11 rounded-xl border px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:focus-visible:ring-offset-zinc-950";

export function InProductConsentNotice({ enabled }: { enabled: boolean }) {
  const { status } = useSession();
  const { lang, t } = useLanguage();
  const router = useRouter();
  const [copyVersion, setCopyVersion] = useState<string | null>(null);
  // Held until the render is recorded, so an answer can never race it.
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const asked = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);

  const language: ConsentCopyLanguage = (CONSENT_COPY_LANGUAGES as readonly string[]).includes(lang)
    ? (lang as ConsentCopyLanguage)
    : "en";

  useEffect(() => {
    if (!enabled || status !== "authenticated" || asked.current) return;
    asked.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/user/consent-notice", { cache: "no-store" });
        if (!response.ok) {
          await discardResponseBody(response);
          return;
        }
        const data = (await response.json()) as { offered?: boolean; copyVersion?: string };
        if (!data.offered || !data.copyVersion) return;
        // Every string of that version must exist before anything is shown:
        // a notice with a missing sentence is not the approved notice.
        if (NOTICE_KEYS.some((key) => consentCopy(key, language, data.copyVersion) === null)) return;
        // Never on top of another dialog: focus and Escape belong to the one
        // already open, and this one would sit under or over it by accident.
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        setCopyVersion(data.copyVersion);
      } catch {
        // Nothing shown; it is asked again on a later visit.
      }
    })();
  }, [enabled, status, language]);

  /** Posts one answer; true only when the server recorded it. */
  const post = useCallback(
    async (action: "shown" | "object" | "accept"): Promise<boolean> => {
      if (!copyVersion) return false;
      try {
        const response = await fetch("/api/user/consent-notice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, language, copyVersion }),
        });
        const data = (await response.json().catch(() => null)) as { recorded?: unknown } | null;
        return response.ok && data?.recorded === true;
      } catch {
        return false;
      }
    },
    [copyVersion, language]
  );

  // Recorded as it renders: that is the fact that stops it reappearing. The
  // answers wait for it.
  useEffect(() => {
    if (!copyVersion) return;
    void post("shown").finally(() => setBusy(false));
  }, [copyVersion, post]);

  const close = useCallback(() => setCopyVersion(null), []);

  const answer = useCallback(
    async (action: "object" | "accept") => {
      setBusy(true);
      setFailed(false);
      const recorded = await post(action);
      setBusy(false);
      if (!recorded) {
        setFailed(true);
        return;
      }
      close();
      if (action === "accept") router.push("/settings/notifications");
    },
    [close, post, router]
  );

  useModalDialog({
    open: copyVersion !== null,
    onClose: close,
    dialogRef,
    panelRef,
    initialFocusRef: acceptRef,
  });

  if (!copyVersion) return null;
  const text = (key: ConsentCopyKey) => consentCopy(key, language, copyVersion) ?? "";

  return (
    <div
      ref={dialogRef}
      data-testid="in-product-consent-notice"
      className="fixed inset-0 z-[150] flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="in-product-consent-notice-title"
      aria-describedby="in-product-consent-notice-body"
    >
      <div
        ref={panelRef}
        className="relative max-h-[calc(100dvh-1rem)] w-full overflow-y-auto overscroll-contain rounded-t-3xl border border-zinc-200 bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-left shadow-2xl sm:max-w-md sm:rounded-3xl sm:pb-5 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2
          id="in-product-consent-notice-title"
          className="text-lg font-bold text-zinc-900 dark:text-zinc-100"
        >
          {text("noticeTitle")}
        </h2>
        <p
          id="in-product-consent-notice-body"
          className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-200"
        >
          {text("noticeBody")}
        </p>
        {failed ? (
          <p
            role="alert"
            data-testid="in-product-consent-notice-failed"
            className="mt-3 text-sm font-medium text-red-700 dark:text-red-300"
          >
            {t("emailNotifications.noticeActionFailed")}
          </p>
        ) : null}
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <button
            ref={acceptRef}
            type="button"
            disabled={busy}
            data-testid="in-product-consent-notice-accept"
            onClick={() => void answer("accept")}
            className={`${answerButtonClass} border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900`}
          >
            {text("noticeAccept")}
          </button>
          <button
            type="button"
            disabled={busy}
            data-testid="in-product-consent-notice-refuse"
            onClick={() => void answer("object")}
            className={`${answerButtonClass} border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900`}
          >
            {text("noticeRefuse")}
          </button>
          <button
            type="button"
            disabled={busy}
            data-testid="in-product-consent-notice-dismiss"
            onClick={close}
            className={`${answerButtonClass} border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900`}
          >
            {text("noticeDismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
