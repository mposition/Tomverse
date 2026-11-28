"use client";

import { GraduationCap, X } from "lucide-react";
import type { ChatStudyCopy } from "@/locales/chatStudy";

/**
 * The composer's two study mode controls, kept out of ChatInput so each can be
 * rendered on its own: the switch in the tools menu, and the chip that shows
 * the mode while it is on. Blue and zinc only: study mode owns no accent role.
 */

/** A switch like web search's: one yes/no for this conversation, flipped in place. */
export function StudyModeRow({
  copy,
  on,
  onToggle,
}: {
  copy: ChatStudyCopy;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby="tools-study-mode-label"
      aria-describedby="tools-study-mode-description"
      data-testid="tools-study-mode-row"
      onClick={onToggle}
      className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600/10 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300">
        <GraduationCap className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span id="tools-study-mode-label" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {copy.modeTitle}
        </span>
        <span id="tools-study-mode-description" className="text-xs text-zinc-500 dark:text-zinc-400">
          {copy.modeDescription}
        </span>
      </span>
      {/* The track is decorative: the button already carries the state as
          `aria-checked`, so repeating it here would announce the switch twice. */}
      <span
        aria-hidden="true"
        data-testid="tools-study-mode-switch-track"
        data-state={on ? "on" : "off"}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          on ? "bg-blue-600 dark:bg-blue-500" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            on ? "left-[1.375rem]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/**
 * The chip in the composer's status row while study mode is on. Same height
 * and 44px hit area as the other status chips, and it wraps with them: it
 * never shares a row with the textarea (docs/ui-contracts/mobile-chat-composer.md).
 */
export function StudyModeChip({
  copy,
  compact,
  onRemove,
}: {
  copy: ChatStudyCopy;
  compact: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      data-testid="study-mode-chip"
      role="group"
      aria-label={copy.chipDescription}
      title={copy.chipDescription}
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 pl-3 pr-1.5 text-xs font-bold text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100 ${compact ? "h-8" : "h-9"}`}
    >
      <GraduationCap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{copy.modeTitle}</span>
      <button
        type="button"
        data-testid="study-mode-chip-remove"
        onClick={onRemove}
        aria-label={copy.chipRemove}
        title={copy.chipRemove}
        className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-blue-700 before:absolute before:content-[''] hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40 ${compact ? "before:-inset-2.5" : "before:-inset-1"}`}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
