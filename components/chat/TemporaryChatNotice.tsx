"use client";

import { Clock3 } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import type { TemporaryChatController } from "@/components/chat/useTemporaryChat";
import { chatPersonalizationCopy } from "@/locales/chatPersonalization";

/**
 * The temporary Chat control above the conversation: a toggle on a new Chat,
 * and a banner with a way out while the open conversation is temporary.
 * Renders nothing when the switch is off or the person is signed out. The
 * sentence it shows is the promise the server keeps (lib/temporaryChatAccess.ts).
 */
export function TemporaryChatNotice({
  controller,
  currentChatId,
  inProject,
  onEnd,
}: {
  controller: TemporaryChatController;
  currentChatId: string | null;
  /** A new Chat that will start inside a project cannot be temporary. */
  inProject: boolean;
  /** Starts a new Chat; leaving the temporary one deletes it. */
  onEnd: () => void;
}) {
  const { lang } = useLanguage();
  const c = chatPersonalizationCopy(lang);
  const active = controller.isActive(currentChatId);
  if (!active && (!controller.available || currentChatId !== null || inProject)) return null;

  if (active) {
    return (
      <div
        data-testid="temporary-chat-banner"
        role="status"
        className="mx-4 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
      >
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
          {c.temporaryBanner}
        </span>
        <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">{c.temporaryDescription}</span>
        <button
          type="button"
          data-testid="temporary-chat-end"
          onClick={onEnd}
          className="min-h-9 shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 font-semibold transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          {c.temporaryEnd}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5">
      <button
        type="button"
        data-testid="temporary-chat-toggle"
        aria-pressed={controller.armed}
        onClick={() => controller.setArmed(!controller.armed)}
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          controller.armed
            ? "border-zinc-800 bg-zinc-800 text-white dark:border-zinc-200 dark:bg-zinc-200 dark:text-zinc-900"
            : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        }`}
      >
        <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
        {controller.armed ? c.temporaryOn : c.temporaryToggle}
      </button>
      {controller.armed && (
        <span data-testid="temporary-chat-description" className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">
          {c.temporaryDescription}
        </span>
      )}
    </div>
  );
}
