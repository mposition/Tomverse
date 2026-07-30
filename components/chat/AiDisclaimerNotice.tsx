"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

/**
 * The AI-accuracy and sensitive-data warning, as one line plus a way to read
 * the rest.
 *
 * The mobile shell used to print the whole notice under the composer: three or
 * four wrapped lines of 10px `zinc-400`, which is both the largest fixed cost
 * in the bottom dock and a contrast failure at that size. Deleting it is not an
 * option -- it is the only place a user is told their prompt and attachments
 * leave for a third-party provider -- so the notice is split instead:
 *
 * - the two warnings that change behaviour ("answers can be wrong", "do not
 *   enter sensitive data") stay on screen, at a contrast ratio that passes
 *   WCAG 2.2 AA for small text;
 * - the approved wording is preserved *verbatim* behind "Details", in a sheet
 *   that is reachable by touch, keyboard and screen reader.
 *
 * The trigger keeps a 44x44 touch target through a pseudo-element rather than
 * by growing the line, so the compressed notice really is one row tall.
 */
export function AiDisclaimerNotice({ testId }: { testId?: string }) {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const dialogId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    // Whatever opened the sheet gets focus back, so a keyboard user is not
    // returned to the top of the document -- on Escape as well as on a tap.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, isOpen]);

  return (
    <>
      <p
        data-testid={testId}
        className="flex shrink-0 items-center justify-center gap-1.5 px-2 pb-[calc(0.4rem+env(safe-area-inset-bottom))] pt-1 text-center text-[11px] leading-4 text-zinc-600 dark:text-zinc-300"
      >
        <span className="min-w-0 truncate">{t("chat.aiDisclaimerShort")}</span>
        <button
          ref={triggerRef}
          type="button"
          data-testid="chat-ai-disclaimer-details"
          onClick={() => setIsOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={isOpen ? dialogId : undefined}
          // The visible control is one line tall so the notice stays a single
          // row; the tap target it actually answers to is the 44px box this
          // pseudo-element paints invisibly around it.
          className="relative shrink-0 rounded font-bold text-blue-700 underline underline-offset-2 before:absolute before:-inset-x-3 before:-inset-y-[0.9rem] before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300"
        >
          {t("chat.aiDisclaimerDetails")}
        </button>
      </p>

      {isOpen && (
        <div
          className="fixed inset-0 z-[95] flex items-end bg-black/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.aiDisclaimerTitle")}
          id={dialogId}
        >
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={close}
            aria-label={t("auth.cancel")}
          />
          <div
            data-testid="chat-ai-disclaimer-sheet"
            className="relative z-10 max-h-[calc(100dvh-1rem)] w-full overflow-y-auto overscroll-contain rounded-t-3xl border-t border-zinc-200 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-left shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                {t("chat.aiDisclaimerTitle")}
              </p>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={close}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
                aria-label={t("auth.cancel")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* The approved wording, unchanged -- the short line above is an
                additional summary, never a replacement. */}
            <p className="mt-1 text-[13px] leading-6 text-zinc-700 dark:text-zinc-200">
              {t("chat.aiDisclaimer")}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
