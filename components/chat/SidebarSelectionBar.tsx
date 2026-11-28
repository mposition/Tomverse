"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, ListChecks, Trash2 } from "lucide-react";

import { useModalDialog } from "@/components/useModalDialog";
import type { ConversationToolsCopy } from "@/locales/conversationTools";

const fill = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

/**
 * The sidebar's selection mode: the control that starts it, and while it is on,
 * the count and the actions that apply to the whole selection.
 *
 * The rows themselves become checkboxes in ChatSidebar; this owns everything
 * that is about the selection rather than one row, including the confirmation
 * a delete must pass. Deleting cannot be undone, so it is never one click: the
 * dialog says how many, and its default focus is Cancel.
 */
export function SidebarSelectionBar({
    copy,
    active,
    onStart,
    onEnd,
    selectedCount,
    visibleCount,
    limit,
    onSelectAll,
    archivedView,
    busy,
    onArchive,
    onDelete,
    touch,
}: {
    copy: ConversationToolsCopy;
    active: boolean;
    onStart: () => void;
    onEnd: () => void;
    selectedCount: number;
    visibleCount: number;
    limit: number;
    onSelectAll: () => void;
    /** The archived view offers "Unarchive" where the others offer "Archive". */
    archivedView: boolean;
    busy: boolean;
    onArchive: () => void;
    onDelete: () => Promise<void>;
    /** The drawer keeps 44px targets; the desktop sidebar has a pointer. */
    touch: boolean;
}) {
    const [confirming, setConfirming] = useState(false);
    const hintId = `${useId()}-selection-hint`;
    const target = touch ? "min-h-11" : "min-h-8";
    const button =
        `inline-flex ${target} items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors ` +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

    if (!active) {
        if (visibleCount === 0) return null;
        return (
            <div className="flex justify-end px-2 pt-1">
                <button
                    type="button"
                    data-testid="sidebar-selection-start"
                    onClick={onStart}
                    className={`${button} text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100`}
                >
                    <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.select}
                </button>
            </div>
        );
    }

    return (
        <div
            role="toolbar"
            aria-label={copy.select}
            aria-describedby={hintId}
            data-testid="sidebar-selection-bar"
            className="mx-2 mt-1 rounded-xl border border-blue-200 bg-blue-50 p-1.5 dark:border-blue-900/60 dark:bg-blue-950/30"
        >
            <p id={hintId} className="sr-only">
                {copy.selectHint}
            </p>
            <div className="flex flex-wrap items-center gap-1">
                <span
                    role="status"
                    aria-live="polite"
                    data-testid="sidebar-selection-count"
                    className="mr-auto px-1.5 text-[12px] font-bold text-blue-800 dark:text-blue-200"
                >
                    {fill(copy.selectionCount, { count: selectedCount })}
                </span>
                <button
                    type="button"
                    data-testid="sidebar-selection-done"
                    onClick={onEnd}
                    className={`${button} text-zinc-700 hover:bg-white dark:text-zinc-200 dark:hover:bg-zinc-900`}
                >
                    {copy.cancelSelection}
                </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
                <button
                    type="button"
                    data-testid="sidebar-selection-all"
                    onClick={onSelectAll}
                    disabled={busy || visibleCount === 0 || selectedCount >= Math.min(visibleCount, limit)}
                    className={`${button} text-zinc-700 hover:bg-white dark:text-zinc-200 dark:hover:bg-zinc-900`}
                >
                    {copy.selectAll}
                </button>
                <button
                    type="button"
                    data-testid="sidebar-selection-archive"
                    onClick={onArchive}
                    disabled={busy || selectedCount === 0}
                    className={`${button} text-zinc-700 hover:bg-white dark:text-zinc-200 dark:hover:bg-zinc-900`}
                >
                    {archivedView ? (
                        <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                        <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {archivedView ? copy.unarchive : copy.archive}
                </button>
                <button
                    type="button"
                    data-testid="sidebar-selection-delete"
                    onClick={() => setConfirming(true)}
                    disabled={busy || selectedCount === 0}
                    className={`${button} text-red-600 hover:bg-white dark:text-red-400 dark:hover:bg-zinc-900`}
                >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.deleteSelected}
                </button>
            </div>
            {confirming && (
                <BulkDeleteConfirmation
                    copy={copy}
                    count={selectedCount}
                    busy={busy}
                    onCancel={() => setConfirming(false)}
                    onConfirm={async () => {
                        await onDelete();
                        setConfirming(false);
                    }}
                />
            )}
        </div>
    );
}

function BulkDeleteConfirmation({
    copy,
    count,
    busy,
    onCancel,
    onConfirm,
}: {
    copy: ConversationToolsCopy;
    count: number;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => Promise<void>;
}) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const cancelRef = useRef<HTMLButtonElement | null>(null);
    useModalDialog({
        open: true,
        onClose: () => {
            if (!busy) onCancel();
        },
        dialogRef,
        panelRef,
        initialFocusRef: cancelRef,
    });
    if (typeof document === "undefined") return null;
    return createPortal(
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sidebar-bulk-delete-title"
            aria-describedby="sidebar-bulk-delete-body"
            data-testid="sidebar-bulk-delete-dialog"
            // Above the mobile drawer (z-80) and the conversation menu (z-120).
            className="fixed inset-0 z-[130] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
            onClick={(event) => {
                if (event.target === event.currentTarget && !busy) onCancel();
            }}
        >
            <div
                ref={panelRef}
                className="w-full max-w-sm rounded-t-2xl bg-white p-4 shadow-xl dark:bg-zinc-950 sm:rounded-2xl"
            >
                <h2 id="sidebar-bulk-delete-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                    {fill(copy.deleteConfirmTitle, { count })}
                </h2>
                <p id="sidebar-bulk-delete-body" className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {copy.deleteConfirmBody}
                </p>
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        ref={cancelRef}
                        type="button"
                        data-testid="sidebar-bulk-delete-cancel"
                        onClick={onCancel}
                        disabled={busy}
                        className="min-h-11 rounded-xl px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                        {copy.cancel}
                    </button>
                    <button
                        type="button"
                        data-testid="sidebar-bulk-delete-confirm"
                        onClick={() => void onConfirm()}
                        disabled={busy}
                        className="min-h-11 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                        {fill(copy.deleteConfirmAction, { count })}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
