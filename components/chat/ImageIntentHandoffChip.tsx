"use client";

import { ImagePlus, LockKeyhole } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

/**
 * The composer's offer to take an image request to the image workspace.
 *
 * Contract: `docs/ui-contracts/image-generation-workspace.md` -- entry point 5
 * and "The handoff chip is an entry point, not an execution".
 * Policy: `docs/policy/image-generation.md` §13.
 *
 * The whole reason this is allowed to be a fifth entry point is that it does
 * nothing until it is pressed. It never switches the draft, never submits a
 * generation, and never blocks the ordinary chat submit behind it -- a person
 * who ignores it and presses send gets the chat turn they typed.
 *
 * Locked viewers see the chip too, with the requirement inside it, because
 * every other image entry point states its requirement before the click rather
 * than after it. Making this one quieter would make the locked case the only
 * place the product refuses at the end.
 *
 * Its own row above the textarea, like the web-search suggestion it sits
 * beside: the mobile composer contract forbids anything sharing, overlapping or
 * floating above the input line.
 */
export type ImageIntentHandoffLock = "sign_in" | "upgrade" | null;

export function ImageIntentHandoffChip({
  lock,
  onAccept,
  onDismiss,
}: {
  lock: ImageIntentHandoffLock;
  /** Press. For a locked viewer this routes to sign-in or `/pricing`. */
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLanguage();
  const requirement =
    lock === "sign_in"
      ? t("modelStatusReasons.loginRequired")
      : lock === "upgrade"
        ? t("modelStatusReasons.upgradeRequired")
        : null;

  return (
    <div
      data-testid="image-intent-handoff-suggestion"
      data-locked={lock ? "true" : "false"}
      className="mb-2 rounded-2xl border border-accent-image-200 bg-accent-image-50 px-3 py-3 dark:border-accent-image-900/60 dark:bg-accent-image-950/20"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-accent-image-600 dark:text-accent-image-300">
            {lock ? (
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ImagePlus className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <p className="text-xs font-bold text-zinc-900 dark:text-white">
              {t("chat.imageIntentSuggestionTitle")}
            </p>
            {/*
              The requirement is part of the chip's own text, not a tooltip and
              not a consequence of pressing it: locked exposure means the
              condition is readable before the click.
            */}
            {requirement && (
              <p
                data-testid="image-intent-handoff-requirement"
                className="mt-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
              >
                {requirement}
              </p>
            )}
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            data-testid="image-intent-handoff-accept"
            onClick={onAccept}
            className="rounded-xl bg-accent-image-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-accent-image-500"
          >
            {t("chat.imageIntentSuggestionAccept")}
          </button>
          <button
            type="button"
            data-testid="image-intent-handoff-dismiss"
            onClick={onDismiss}
            className="rounded-xl border border-accent-image-300 bg-white px-3 py-2 text-[11px] font-bold text-accent-image-900 transition hover:bg-accent-image-100 dark:border-accent-image-800 dark:bg-zinc-950 dark:text-accent-image-200"
          >
            {t("chat.imageIntentSuggestionDismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
