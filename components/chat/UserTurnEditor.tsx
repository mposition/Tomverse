"use client";

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { isComposingKeydown } from "@/lib/chatKeyboardPolicy";
import { chatTurnToolsCopy } from "@/locales/chatTurnTools";

/**
 * Edit the newest question in place and send it again.
 *
 * There is no branch: the edited text is sent as the next turn, the earlier
 * question and its answer stay where they are, marked as replaced
 * (lib/chatSupersededTurns.ts). Only a question without files can be edited,
 * because a resend carries text alone; the caller does not offer this for one
 * with attachments.
 */
export function UserTurnEditor({
  initialText,
  disabled,
  onSubmit,
}: {
  initialText: string;
  disabled?: boolean;
  onSubmit: (text: string) => void;
}) {
  const { lang } = useLanguage();
  const copy = chatTurnToolsCopy[lang];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const unchanged = draft.trim() === initialText.trim();
  const canSave = !disabled && draft.trim().length > 0 && !unchanged;

  const save = () => {
    if (!canSave) return;
    setEditing(false);
    onSubmit(draft.trim());
  };

  if (!editing) {
    return (
      <button
        type="button"
        data-testid="chat-edit-last-question"
        aria-label={copy.editQuestionLabel}
        disabled={disabled}
        onClick={() => {
          setDraft(initialText);
          setEditing(true);
          // The textarea mounts on the next frame.
          requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        className="mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-100"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        {copy.editQuestion}
      </button>
    );
  }

  return (
    <div data-testid="chat-edit-last-question-form" className="mt-2 w-full max-w-[94%] space-y-2 md:max-w-[88%]">
      <textarea
        ref={textareaRef}
        data-testid="chat-edit-last-question-input"
        aria-label={copy.editQuestionLabel}
        value={draft}
        rows={Math.min(8, Math.max(3, draft.split("\n").length))}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isComposingKeydown(event)) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        className="block w-full resize-y rounded-xl border border-zinc-300 bg-white px-3 py-2 text-base leading-6 text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 md:text-[15px]"
      />
      <p className="text-[12px] leading-4 text-zinc-500 dark:text-zinc-400">{copy.editHint}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="min-h-9 rounded-full border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
        >
          {copy.cancel}
        </button>
        <button
          type="button"
          data-testid="chat-edit-last-question-save"
          onClick={save}
          disabled={!canSave}
          className="min-h-9 rounded-full bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.editSave}
        </button>
      </div>
    </div>
  );
}
