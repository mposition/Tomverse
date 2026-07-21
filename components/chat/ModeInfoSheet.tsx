"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Lock, UserRound, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

type ModeInfoSheetProps = {
  mode: "guest" | "private" | null;
  onClose: () => void;
  guestMessageCount?: number;
  maxGuestMessages?: number;
};

export function ModeInfoSheet({
  mode,
  onClose,
  guestMessageCount = 0,
  maxGuestMessages = 20,
}: ModeInfoSheetProps) {
  const { t } = useLanguage();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!mode) return;

    const focusFrame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [mode, onClose]);

  if (!mode) return null;

  const isGuest = mode === "guest";

  return (
    <div
      className="fixed inset-0 z-[95] flex items-end bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={isGuest ? t("chat.onGuestMode") : t("chat.onPrivateMode")}
    >
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
        aria-label={t("auth.cancel")}
      />
      <div className="relative z-10 w-full rounded-t-3xl border-t border-zinc-200 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <div className="flex items-start justify-between gap-2">
          <p
            className={`flex items-center gap-2 text-sm font-bold ${
              isGuest ? "text-blue-700 dark:text-blue-300" : "text-purple-700 dark:text-purple-300"
            }`}
          >
            {isGuest ? <UserRound className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            {isGuest ? t("chat.onGuestMode") : t("chat.onPrivateMode")}
          </p>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
            aria-label={t("auth.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {isGuest ? t("chat.guestModeMessage") : t("chat.privateModeMessage")}
        </p>
        {isGuest && (
          <p className="mt-1 text-sm font-semibold text-blue-600 dark:text-blue-400">
            {t("chat.guestModeLimitMessage")} · {guestMessageCount}/{maxGuestMessages}
          </p>
        )}
        {isGuest && (
          <Link
            href="/auth/signin"
            className="mt-4 flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-blue-500"
          >
            {t("auth.login")}
          </Link>
        )}
      </div>
    </div>
  );
}
