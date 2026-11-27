"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  isMacPlatform,
  resolveChatShortcut,
  shortcutRows,
  type ChatShortcutAction,
} from "@/lib/chatShortcuts";
import { chatTurnToolsCopy, type ChatTurnToolsCopy } from "@/locales/chatTurnTools";

export const CHAT_SHORTCUTS_OPEN_EVENT = "tomverse:chat-shortcuts-open";

export const openChatShortcuts = () => window.dispatchEvent(new Event(CHAT_SHORTCUTS_OPEN_EVENT));

const ROW_LABEL: Record<ChatShortcutAction, keyof ChatTurnToolsCopy> = {
  "new-chat": "shortcutsNewChat",
  search: "shortcutsSearch",
  "focus-composer": "shortcutsComposer",
  "copy-last-answer": "shortcutsCopyLast",
  "show-shortcuts": "shortcutsShow",
};

/**
 * Global Chat shortcuts and the list that documents them. Mounted once per
 * workspace shell; it renders nothing until the list is opened.
 */
export function ChatShortcutsHost({ onNewChat }: { onNewChat: () => void }) {
  const { lang } = useLanguage();
  const copy = chatTurnToolsCopy[lang];
  const [open, setOpen] = useState(false);
  const [isMac] = useState(() => isMacPlatform());
  const onNewChatRef = useRef(onNewChat);
  useEffect(() => {
    onNewChatRef.current = onNewChat;
  }, [onNewChat]);

  useEffect(() => {
    const run = (action: ChatShortcutAction): boolean => {
      switch (action) {
        case "new-chat":
          onNewChatRef.current();
          return true;
        case "search": {
          const input = document.querySelector<HTMLInputElement>('[data-chat-shortcut-target="conversation-search"]');
          if (!input) return false;
          input.focus();
          input.select();
          return true;
        }
        case "focus-composer": {
          const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-textarea"]');
          if (!input) return false;
          input.focus();
          return true;
        }
        case "copy-last-answer": {
          const buttons = document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-copy-response"]');
          const last = buttons[buttons.length - 1];
          if (!last) return false;
          last.click();
          return true;
        }
        case "show-shortcuts":
          setOpen(true);
          return true;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = resolveChatShortcut(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          defaultPrevented: event.defaultPrevented,
          target: target && {
            tagName: target.tagName,
            isContentEditable: target.isContentEditable,
            type: target instanceof HTMLInputElement ? target.type : undefined,
            role: target.getAttribute("role"),
          },
        },
        { isMac }
      );
      if (action && run(action)) event.preventDefault();
    };
    const onOpenRequest = () => setOpen(true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener(CHAT_SHORTCUTS_OPEN_EVENT, onOpenRequest);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(CHAT_SHORTCUTS_OPEN_EVENT, onOpenRequest);
    };
  }, [isMac]);

  const close = useCallback(() => setOpen(false), []);
  if (!open) return null;
  return <ShortcutsDialog rows={shortcutRows(isMac)} copy={copy} onClose={close} />;
}

function ShortcutsDialog({
  rows,
  copy,
  onClose,
}: {
  rows: ReturnType<typeof shortcutRows>;
  copy: ChatTurnToolsCopy;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        // One focusable control: keep focus inside the dialog.
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-shortcuts-title"
        data-testid="chat-shortcuts-dialog"
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-900 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="chat-shortcuts-title" className="text-base font-bold">
            {copy.shortcutsTitle}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-9 rounded-full border border-zinc-300 px-3 text-xs font-bold hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            {copy.shortcutsClose}
          </button>
        </div>
        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.action} className="flex items-center justify-between gap-3 text-sm">
              <span>{copy[ROW_LABEL[row.action]]}</span>
              <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {row.keys.map((combo, index) => (
                  <span key={index} className="inline-flex items-center gap-1">
                    {index > 0 && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">/</span>}
                    {combo.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold dark:border-zinc-600 dark:bg-zinc-800"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[12px] leading-4 text-zinc-500 dark:text-zinc-400">{copy.shortcutsNote}</p>
      </div>
    </div>
  );
}
