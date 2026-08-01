"use client";

import type { RefObject } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  guestVerificationFailureKey,
  type GuestVerificationSurface,
} from "@/components/chat/guestVerificationCopy";
import type { GuestVerificationFailure } from "@/components/chat/guestVerificationFailure";

/**
 * The place a standalone form puts its Turnstile widget.
 *
 * The rule this encodes: the container must exist and stay renderable for the
 * whole verification -- Cloudflare cannot run a challenge inside a
 * `display: none` box -- but it may not occupy a single pixel until Cloudflare
 * actually asks for an interaction. So the closed state is out of flow and
 * transparent rather than hidden, exactly as the chat surfaces do it
 * (GuestVerificationDesktopSlot, GuestVerificationSheet).
 *
 * The failure sentence comes from the shared mapping, so a cancelled check
 * reads the same here as it does in chat.
 */
export function TurnstileFormSlot({
  containerRef,
  isChallengeVisible,
  failure,
  surface = "chat",
  onCancel,
  testId = "turnstile-form-slot",
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  isChallengeVisible: boolean;
  failure: GuestVerificationFailure | null;
  surface?: GuestVerificationSurface;
  onCancel?: () => void;
  testId?: string;
}) {
  const { t } = useLanguage();

  return (
    <div
      data-testid={testId}
      data-visible={isChallengeVisible ? "true" : "false"}
      aria-hidden={isChallengeVisible ? undefined : true}
      {...(isChallengeVisible
        ? { role: "group", "aria-label": t("chat.guestVerificationTitle") }
        : {})}
      className={
        isChallengeVisible
          ? "mt-3 flex w-full min-w-0 flex-col items-center gap-2"
          : "pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0"
      }
    >
      {isChallengeVisible ? (
        <p className="w-full text-xs font-semibold leading-5 text-zinc-600 break-keep dark:text-zinc-300">
          {t("chat.guestVerificationDescription")}
        </p>
      ) : null}
      <div
        ref={containerRef}
        data-testid={`${testId}-widget`}
        className="flex w-full min-w-0 justify-center"
      />
      {isChallengeVisible && failure ? (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          className="w-full text-xs font-semibold leading-5 text-red-600 break-keep dark:text-red-400"
        >
          {t(guestVerificationFailureKey(failure, surface))}
        </p>
      ) : null}
      {isChallengeVisible && onCancel ? (
        <button
          type="button"
          data-testid={`${testId}-cancel`}
          onClick={onCancel}
          className="min-h-11 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm font-bold text-zinc-600 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          {t("chat.guestVerificationClose")}
        </button>
      ) : null}
    </div>
  );
}
