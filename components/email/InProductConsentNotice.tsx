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
 * - **Yes** opens the email settings. Consent is requested and confirmed
 *   there, with the person's country, and nothing here records a consent.
 * - **No, thank you** is an objection, recorded against the mailbox.
 * - **Not now** closes it. The render was already recorded when it appeared,
 *   which is what keeps it from coming back; closing adds nothing.
 *
 * Asked only where the server says so (`/api/user/consent-notice`), which is
 * off unless the collection gate and a working confirmation both exist. The
 * words are the approved version the server named, never today's by default.
 */
export function InProductConsentNotice({ enabled }: { enabled: boolean }) {
  const { status } = useSession();
  const { lang } = useLanguage();
  const router = useRouter();
  const [copyVersion, setCopyVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
        const keys: ConsentCopyKey[] = [
          "noticeTitle",
          "noticeBody",
          "noticeAccept",
          "noticeRefuse",
          "noticeDismiss",
        ];
        if (keys.some((key) => consentCopy(key, language, data.copyVersion) === null)) return;
        setCopyVersion(data.copyVersion);
      } catch {
        // Nothing shown; it is asked again on a later visit.
      }
    })();
  }, [enabled, status, language]);

  const post = useCallback(
    async (action: "shown" | "object") => {
      if (!copyVersion) return;
      try {
        const response = await fetch("/api/user/consent-notice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, language, copyVersion }),
        });
        await discardResponseBody(response);
      } catch {
        // Best effort: the render is asked about again on a later visit.
      }
    },
    [copyVersion, language]
  );

  // Recorded as it renders: that is the fact that stops it reappearing.
  useEffect(() => {
    if (copyVersion) void post("shown");
  }, [copyVersion, post]);

  const close = useCallback(() => setCopyVersion(null), []);

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
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
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
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            ref={acceptRef}
            type="button"
            disabled={busy}
            data-testid="in-product-consent-notice-accept"
            onClick={() => {
              close();
              router.push("/settings/notifications");
            }}
            className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:focus-visible:ring-offset-zinc-950"
          >
            {text("noticeAccept")}
          </button>
          <button
            type="button"
            disabled={busy}
            data-testid="in-product-consent-notice-refuse"
            onClick={() => {
              setBusy(true);
              void post("object").finally(() => {
                setBusy(false);
                close();
              });
            }}
            className="min-h-11 rounded-xl border border-zinc-300 px-4 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
          >
            {text("noticeRefuse")}
          </button>
          <button
            type="button"
            disabled={busy}
            data-testid="in-product-consent-notice-dismiss"
            onClick={close}
            className="min-h-11 rounded-xl px-4 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 sm:mr-auto dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {text("noticeDismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
