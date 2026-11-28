"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { signIn } from "next-auth/react";
import { ScrollText, X } from "lucide-react";

import { useModalDialog } from "@/components/useModalDialog";
import { dispatchAppToast } from "@/lib/appToast";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { Language } from "@/lib/language";
import {
    SAVED_PROMPT_LIMITS,
    composerTextWithSavedPrompt,
    suggestedSavedPromptTitle,
    type SavedPrompt,
} from "@/lib/savedPromptsCore";
import { savedPromptsCopy } from "@/locales/savedPrompts";

const fill = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

/**
 * "Saved prompts" in the composer's tools menu: the row, and the picker it
 * opens. Everything the feature needs is here, so the composer carries one
 * element for it (components/chat/ChatInput.tsx).
 *
 * Picking a prompt puts its text into the composer and sends nothing; text
 * already there is kept and the prompt goes after it. The composer's current
 * text can be saved from the same picker, and each prompt can be renamed,
 * edited or deleted in place -- the smallest management surface there is.
 *
 * The picker opens over the tools menu and leaves it open behind, so closing
 * the picker returns to the menu; putting a prompt in closes both.
 */
export function SavedPromptsTool({
    language,
    value,
    isGuestMode,
    disabled,
    onInsert,
    onDone,
}: {
    language: Language;
    /** The composer's text now: what "save" would keep, and what a pick is added to. */
    value: string;
    isGuestMode: boolean;
    disabled: boolean;
    onInsert: (text: string) => void;
    /** Close the tools menu. */
    onDone: () => void;
}) {
    const copy = savedPromptsCopy[language];
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                data-testid="tools-saved-prompts-row"
                disabled={disabled}
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
            >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    <ScrollText className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{copy.rowTitle}</span>
                    <span className="truncate text-xs text-zinc-500">
                        {isGuestMode ? copy.signInPrompt : copy.rowDescription}
                    </span>
                </span>
            </button>
            {open && (
                <SavedPromptsDialog
                    language={language}
                    value={value}
                    isGuestMode={isGuestMode}
                    onClose={() => setOpen(false)}
                    onPick={(prompt) => {
                        onInsert(composerTextWithSavedPrompt(value, prompt.body));
                        setOpen(false);
                        onDone();
                    }}
                />
            )}
        </>
    );
}

type Editing = { id: string | null; title: string; body: string };

function SavedPromptsDialog({
    language,
    value,
    isGuestMode,
    onClose,
    onPick,
}: {
    language: Language;
    value: string;
    isGuestMode: boolean;
    onClose: () => void;
    onPick: (prompt: SavedPrompt) => void;
}) {
    const copy = savedPromptsCopy[language];
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [editing, setEditing] = useState<Editing | null>(null);
    const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useModalDialog({ open: true, onClose, dialogRef, panelRef });

    // The tools menu closes on a mousedown outside it. This picker opened from
    // that menu, so its clicks are not "outside": they stop here.
    useEffect(() => {
        const node = dialogRef.current;
        if (!node) return;
        const keep = (event: MouseEvent) => event.stopPropagation();
        node.addEventListener("mousedown", keep);
        return () => node.removeEventListener("mousedown", keep);
    }, []);

    useEffect(() => {
        if (isGuestMode) return;
        const controller = new AbortController();
        void fetch("/api/saved-prompts", { cache: "no-store", signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) {
                    await discardResponseBody(response);
                    setLoadFailed(true);
                    return;
                }
                const body = (await response.json()) as { prompts?: SavedPrompt[] };
                setPrompts(Array.isArray(body.prompts) ? body.prompts : []);
            })
            .catch(() => {
                if (!controller.signal.aborted) setLoadFailed(true);
            });
        return () => controller.abort();
    }, [isGuestMode]);

    const atLimit = (prompts?.length ?? 0) >= SAVED_PROMPT_LIMITS.count;

    const save = async () => {
        if (!editing || busy) return;
        setBusy(true);
        try {
            const response = await fetch(editing.id ? `/api/saved-prompts/${encodeURIComponent(editing.id)}` : "/api/saved-prompts", {
                method: editing.id ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: editing.title, body: editing.body }),
            });
            const body = (await response.json().catch(() => null)) as { prompt?: SavedPrompt; code?: string } | null;
            if (!response.ok || !body?.prompt) {
                dispatchAppToast(
                    body?.code === "SAVED_PROMPT_LIMIT"
                        ? fill(copy.limitReached, { limit: SAVED_PROMPT_LIMITS.count })
                        : copy.failed,
                    "error"
                );
                return;
            }
            const saved = body.prompt;
            setPrompts((current) =>
                editing.id
                    ? (current ?? []).map((prompt) => (prompt.id === saved.id ? saved : prompt))
                    : [saved, ...(current ?? [])]
            );
            setEditing(null);
            dispatchAppToast(copy.saved, "success");
        } catch {
            dispatchAppToast(copy.failed, "error");
        } finally {
            setBusy(false);
        }
    };

    const remove = async (id: string) => {
        if (armedDeleteId !== id) {
            setArmedDeleteId(id);
            return;
        }
        setBusy(true);
        try {
            const response = await fetch(`/api/saved-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
            await discardResponseBody(response);
            if (!response.ok && response.status !== 404) {
                dispatchAppToast(copy.failed, "error");
                return;
            }
            setPrompts((current) => (current ?? []).filter((prompt) => prompt.id !== id));
            setArmedDeleteId(null);
        } catch {
            dispatchAppToast(copy.failed, "error");
        } finally {
            setBusy(false);
        }
    };

    const smallButton =
        "inline-flex min-h-9 items-center rounded-lg px-2.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

    if (typeof document === "undefined") return null;
    return createPortal(
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="saved-prompts-title"
            data-testid="saved-prompts-dialog"
            // Above the composer's tools menu (z-100) that it opens from.
            className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
            onClick={(event) => {
                if (event.target === event.currentTarget && !busy) onClose();
            }}
        >
            <div
                ref={panelRef}
                className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white p-4 shadow-xl dark:bg-zinc-950 sm:rounded-2xl"
            >
                <div className="flex items-center justify-between gap-2">
                    <h2 id="saved-prompts-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                        {copy.dialogTitle}
                    </h2>
                    <span className="ml-auto text-xs text-zinc-500" data-testid="saved-prompts-count">
                        {prompts ? fill(copy.count, { count: prompts.length, limit: SAVED_PROMPT_LIMITS.count }) : ""}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={copy.close}
                        className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                {isGuestMode ? (
                    <div className="mt-2 space-y-3" data-testid="saved-prompts-sign-in">
                        <p className="text-sm text-zinc-600 dark:text-zinc-300">{copy.signInPrompt}</p>
                        <button
                            type="button"
                            onClick={() => void signIn(undefined, { callbackUrl: `${window.location.pathname}${window.location.search}` })}
                            className="min-h-11 w-full rounded-xl bg-blue-600 px-3 text-sm font-bold text-white hover:bg-blue-500"
                        >
                            {copy.signIn}
                        </button>
                    </div>
                ) : editing ? (
                    <SavedPromptEditor
                        language={language}
                        editing={editing}
                        busy={busy}
                        onChange={setEditing}
                        onCancel={() => setEditing(null)}
                        onSave={() => void save()}
                    />
                ) : (
                    <div className="mt-2 flex min-h-0 flex-col gap-2">
                        <button
                            type="button"
                            data-testid="saved-prompts-save-current"
                            disabled={!value.trim() || atLimit || prompts === null}
                            onClick={() =>
                                setEditing({
                                    id: null,
                                    title: suggestedSavedPromptTitle(value),
                                    // All of it: a prompt over the limit is shown as
                                    // over and cannot be saved, never cut to fit.
                                    body: value,
                                })
                            }
                            className="min-h-11 rounded-xl border border-dashed border-zinc-300 px-3 text-left text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                            {copy.saveCurrent}
                        </button>
                        {(atLimit || !value.trim()) && prompts !== null && (
                            <p className="text-xs text-zinc-500">
                                {atLimit ? fill(copy.limitReached, { limit: SAVED_PROMPT_LIMITS.count }) : copy.saveCurrentEmpty}
                            </p>
                        )}
                        {loadFailed ? (
                            <p role="status" className="py-4 text-sm text-zinc-500">{copy.loadFailed}</p>
                        ) : prompts === null ? (
                            <p role="status" className="py-4 text-sm text-zinc-500">{copy.loading}</p>
                        ) : prompts.length === 0 ? (
                            <p className="py-4 text-sm text-zinc-500" data-testid="saved-prompts-empty">{copy.empty}</p>
                        ) : (
                            <ul className="min-h-0 space-y-1 overflow-y-auto overscroll-contain" data-testid="saved-prompts-list">
                                {prompts.map((prompt) => (
                                    <li
                                        key={prompt.id}
                                        data-testid="saved-prompt-item"
                                        className="rounded-xl border border-zinc-200 p-2 dark:border-zinc-800"
                                    >
                                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{prompt.title}</p>
                                        <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-zinc-500">{prompt.body}</p>
                                        <div className="mt-1 flex flex-wrap justify-end gap-1">
                                            <button
                                                type="button"
                                                data-testid="saved-prompt-use"
                                                onClick={() => onPick(prompt)}
                                                disabled={busy}
                                                aria-label={`${copy.use}: ${prompt.title}`}
                                                className={`${smallButton} bg-blue-600 text-white hover:bg-blue-500`}
                                            >
                                                {copy.use}
                                            </button>
                                            <button
                                                type="button"
                                                data-testid="saved-prompt-edit"
                                                onClick={() => {
                                                    setArmedDeleteId(null);
                                                    setEditing({ id: prompt.id, title: prompt.title, body: prompt.body });
                                                }}
                                                disabled={busy}
                                                aria-label={`${copy.edit}: ${prompt.title}`}
                                                className={`${smallButton} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800`}
                                            >
                                                {copy.edit}
                                            </button>
                                            <button
                                                type="button"
                                                data-testid="saved-prompt-delete"
                                                onClick={() => void remove(prompt.id)}
                                                disabled={busy}
                                                aria-label={`${armedDeleteId === prompt.id ? copy.deleteConfirm : copy.delete}: ${prompt.title}`}
                                                className={`${smallButton} ${
                                                    armedDeleteId === prompt.id
                                                        ? "bg-red-600 text-white hover:bg-red-700"
                                                        : "text-red-600 hover:bg-zinc-100 dark:text-red-400 dark:hover:bg-zinc-800"
                                                }`}
                                            >
                                                {armedDeleteId === prompt.id ? copy.deleteConfirm : copy.delete}
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}

const FIELD =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/**
 * Naming and editing one prompt. The text is held whole: a prompt longer than
 * the limit is not cut to fit, it is shown as over the limit with its length,
 * and Save waits until it is short enough. (The server refuses it too.)
 */
export function SavedPromptEditor({
    language,
    editing,
    busy,
    onChange,
    onCancel,
    onSave,
}: {
    language: Language;
    editing: Editing;
    busy: boolean;
    onChange: (editing: Editing) => void;
    onCancel: () => void;
    onSave: () => void;
}) {
    const copy = savedPromptsCopy[language];
    const tooLong = editing.body.length > SAVED_PROMPT_LIMITS.bodyMax;
    return (
        <form
            className="mt-2 flex min-h-0 flex-col gap-2"
            data-testid="saved-prompts-editor"
            onSubmit={(event) => {
                event.preventDefault();
                if (!tooLong) onSave();
            }}
        >
            <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-300" htmlFor="saved-prompt-name">
                {copy.nameLabel}
            </label>
            <input
                id="saved-prompt-name"
                data-testid="saved-prompt-name"
                className={FIELD}
                value={editing.title}
                maxLength={SAVED_PROMPT_LIMITS.titleMax}
                onChange={(event) => onChange({ ...editing, title: event.target.value })}
                required
            />
            <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-300" htmlFor="saved-prompt-body">
                {copy.promptLabel}
            </label>
            <textarea
                id="saved-prompt-body"
                data-testid="saved-prompt-body"
                className={`${FIELD} min-h-40 flex-1 resize-y`}
                value={editing.body}
                onChange={(event) => onChange({ ...editing, body: event.target.value })}
                aria-invalid={tooLong || undefined}
                aria-describedby="saved-prompt-body-length"
                required
            />
            <p
                id="saved-prompt-body-length"
                data-testid="saved-prompt-body-length"
                role={tooLong ? "alert" : undefined}
                className={`text-right text-[11px] ${tooLong ? "font-semibold text-red-600 dark:text-red-400" : "text-zinc-500"}`}
            >
                {tooLong
                    ? fill(copy.bodyTooLong, { count: editing.body.length, limit: SAVED_PROMPT_LIMITS.bodyMax })
                    : `${editing.body.length}/${SAVED_PROMPT_LIMITS.bodyMax}`}
            </p>
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={busy}
                    className="min-h-11 rounded-xl px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                    {copy.cancel}
                </button>
                <button
                    type="submit"
                    data-testid="saved-prompt-save"
                    disabled={busy || tooLong || !editing.title.trim() || !editing.body.trim()}
                    className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                >
                    {copy.save}
                </button>
            </div>
        </form>
    );
}
