"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { interpolateCopy, projectErrorKey } from "@/lib/projectWorkspaceUi";

/** Shared look of the Project workspace: neutral zinc with the primary blue, 44px touch targets. */
export const projectUi = {
    button: "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
    primary: "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-zinc-900",
    danger: "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/40",
    dangerSolid: "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-zinc-900",
    input: "min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100",
    card: "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900",
    muted: "text-sm text-zinc-600 dark:text-zinc-400",
    label: "mb-1 block text-sm font-semibold text-zinc-800 dark:text-zinc-200",
    chip: "inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    chipWarn: "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    chipBad: "inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800 dark:bg-red-900/40 dark:text-red-200",
    chipGood: "inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
} as const;

type ResourceState<T> = { key: string; status: "loading" | "ready" | "error"; data?: T; error?: unknown };

/**
 * Loads one thing for a pane and lets the pane reload it. A change of `key`
 * (another project) starts a clean loading state, so the previous project's
 * data is never painted under the next one's name; a late answer for an old
 * key is dropped.
 */
export function useProjectResource<T>(load: () => Promise<T>, key: string) {
    const [state, setState] = useState<ResourceState<T>>({ key, status: "loading" });
    const loadRef = useRef(load);
    const generation = useRef(0);
    useLayoutEffect(() => {
        loadRef.current = load;
    });

    const run = useCallback(
        async (options?: { quiet?: boolean }) => {
            const ticket = ++generation.current;
            if (!options?.quiet) setState((current) => (current.key === key && current.status === "ready" ? current : { key, status: "loading" }));
            try {
                const data = await loadRef.current();
                if (ticket === generation.current) setState({ key, status: "ready", data });
            } catch (error) {
                if (ticket === generation.current) {
                    setState((current) => (options?.quiet && current.key === key && current.status === "ready" ? current : { key, status: "error", error }));
                }
            }
        },
        [key]
    );

    useEffect(() => {
        queueMicrotask(() => void run());
        return () => {
            generation.current += 1;
        };
    }, [run]);

    const current = state.key === key ? state : ({ key, status: "loading" } as ResourceState<T>);
    return {
        status: current.status,
        data: current.data,
        error: current.error,
        reload: run,
        setData: (next: T) => setState({ key, status: "ready", data: next }),
    };
}

export function Spinner({ label }: { label?: string }) {
    return (
        <span role="status" className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {label}
        </span>
    );
}

/** One line for a failed request, in the owner's language, with an optional retry. */
export function ErrorLine({ error, onRetry, testId }: { error: unknown; onRetry?: () => void; testId?: string }) {
    const { t } = useLanguage();
    return (
        <p role="alert" data-testid={testId ?? "project-error"} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
            <span>{t(projectErrorKey(error))}</span>
            {onRetry && (
                <button type="button" onClick={onRetry} className="min-h-11 rounded-lg px-2 underline underline-offset-2">
                    {t("projectWorkspace.retry")}
                </button>
            )}
        </p>
    );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
    return (
        <div data-testid="project-empty" className="rounded-xl border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</p>
            {body && <p className={`${projectUi.muted} mx-auto mt-1 max-w-md`}>{body}</p>}
            {action && <div className="mt-3 flex justify-center">{action}</div>}
        </div>
    );
}

/** A modal confirmation with the shared focus contract; the body says exactly what will happen. */
export function ConfirmDialog({
    open,
    title,
    children,
    confirmLabel,
    cancelLabel,
    destructive = false,
    busy = false,
    confirmDisabled = false,
    error,
    onConfirm,
    onCancel,
    testId,
}: {
    open: boolean;
    title: string;
    children: ReactNode;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
    busy?: boolean;
    confirmDisabled?: boolean;
    error?: unknown;
    onConfirm: () => void;
    onCancel: () => void;
    testId?: string;
}) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    useModalDialog({ open, onClose: busy ? () => undefined : onCancel, dialogRef, panelRef });
    if (!open || typeof document === "undefined") return null;
    return createPortal(
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="project-confirm-title" data-testid={testId ?? "project-confirm-dialog"} className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-3">
            <div ref={panelRef} tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
                <h2 id="project-confirm-title" className="text-lg font-bold">{title}</h2>
                <div className="space-y-2 text-sm">{children}</div>
                {error ? <ErrorLine error={error} /> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" disabled={busy} onClick={onCancel} className={projectUi.button}>{cancelLabel}</button>
                    <button type="button" disabled={busy || confirmDisabled} onClick={onConfirm} data-testid="project-confirm-submit" className={destructive ? projectUi.dangerSolid : projectUi.primary}>
                        {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/** Translation with `{placeholders}`, since the provider's `t` only resolves keys. */
export function useCopy() {
    const { t, lang } = useLanguage();
    const tf = useCallback((key: string, values: Record<string, string | number>) => interpolateCopy(t(key), values), [t]);
    return { t, tf, lang };
}

export function formatProjectDate(value: string | null | undefined, lang: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    try {
        return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(date);
    } catch {
        return date.toLocaleString();
    }
}
