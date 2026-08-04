"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    ArrowLeft,
    Check,
    Download,
    Loader2,
    Pin,
    PinOff,
    Plus,
    Trash2,
    X,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { MemoryExtractionLauncher } from "@/components/memory/MemoryExtractionLauncher";
import {
    FACTUAL_MEMORY_KINDS,
    MEMORY_STATEMENT_MAX_CODE_POINTS,
    STYLE_MEMORY_KINDS,
    type MemoryKind,
} from "@/lib/memoryValidatorCore";

/**
 * /settings/memory — the Release B review surface (policy §8, §21, slice B3).
 *
 * Split of authority with the API (docs/policy/
 * external-conversation-import-and-memory.md §15 never-strand posture):
 * the list, the delete action and the account memory settings are NOT
 * flag-gated server-side, so this page always renders what the user has
 * stored. Review mutations (approve/reject/edit/pin, bulk approve, manual
 * creation) are flag-gated; the server answering MEMORY_FEATURE_DISABLED is
 * the probe, and the page then shows the disabled notice while keeping the
 * stored items visible and deletable.
 *
 * Nothing here decides what a memory is worth: approval calls re-run the
 * server validator, and a 409 conflict (MEMORY_ITEM_CONFLICT) always comes
 * back to the user as an explicit keep-or-replace choice (§8.3) — the UI
 * never resolves it silently.
 */

const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const smallButtonClass =
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const badgeClass =
    "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold";

const PAGE_SIZE = 100;

/**
 * Typed exactly, never translated: the server compares this literal, so a
 * localized phrase would be rejected. Same contract as account deletion.
 */
const DELETE_ALL_CONFIRMATION = "DELETE ALL MEMORIES";

export type MemoryEvidenceView = {
    id: string;
    sourceType: string;
    manualContent: string | null;
    externalConversationId: string | null;
};

export type MemoryRowView = {
    id: string;
    kind: string;
    statement: string;
    status: string;
    sensitivity: string;
    confidence: number;
    importance: number;
    pinned: boolean;
    conflictKey: string | null;
    revision: number;
    userEdited: boolean;
    expiresAt: string | null;
    suspendedReason: string | null;
    extractionModelId: string | null;
    promptVersion: string | null;
    createdAt: string;
    approvedAt: string | null;
    evidence: MemoryEvidenceView[];
};

type MemorySettings = {
    masterEnabled: boolean;
    styleEnabled: boolean;
    defaultConversationMode: "on" | "off";
};

type SettingsState =
    | { kind: "loading" }
    | { kind: "ready"; settings: MemorySettings; saving: boolean }
    | { kind: "unauthenticated" }
    | { kind: "error" };

type ListState =
    | { kind: "loading" }
    | { kind: "ready"; rows: MemoryRowView[]; total: number }
    | { kind: "error" };

const REVIEW_STATUSES = ["candidate", "manual_review_required"] as const;

const ARCHIVED_STATUSES = [
    "rejected",
    "superseded",
    "expired",
    "suspended_by_source_lock",
    "suspended_by_source_delete",
] as const;

type ApiFailure = {
    status: number;
    code: string | null;
};

/**
 * Runs a mutation and normalizes the three outcomes every action here has:
 * success, a coded failure the caller reacts to, and a transport error.
 */
async function callApi(
    input: string,
    init: RequestInit
): Promise<{ ok: true; body: unknown } | { ok: false; failure: ApiFailure }> {
    try {
        const response = await fetch(input, init);
        if (response.ok) {
            return { ok: true, body: await response.json().catch(() => null) };
        }
        const body = (await response.json().catch(() => null)) as {
            code?: string;
        } | null;
        return {
            ok: false,
            failure: {
                status: response.status,
                code: typeof body?.code === "string" ? body.code : null,
            },
        };
    } catch {
        return { ok: false, failure: { status: 0, code: null } };
    }
}

function kindLabelKey(kind: string) {
    return `memoryReview.kind.${kind}`;
}

function statusLabelKey(status: string) {
    return `memoryReview.status.${status}`;
}

function StatusBadge({ status }: { status: string }) {
    const { t } = useLanguage();
    return (
        <span
            className={`${badgeClass} bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`}
        >
            {t(statusLabelKey(status))}
        </span>
    );
}

function EvidenceList({ evidence }: { evidence: MemoryEvidenceView[] }) {
    const { t } = useLanguage();
    if (evidence.length === 0) return null;
    return (
        <ul className="mt-2 space-y-1">
            {evidence.map((item) => (
                <li
                    key={item.id}
                    className="rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-1.5 text-xs leading-5 text-zinc-500 dark:border-zinc-800/60 dark:bg-zinc-900/60 dark:text-zinc-400"
                >
                    {item.sourceType === "manual" ? (
                        <>
                            <span className="font-semibold">
                                {t("memoryReview.evidenceManual")}
                            </span>
                            {item.manualContent && (
                                <span className="ml-1.5 break-words">
                                    {item.manualContent}
                                </span>
                            )}
                        </>
                    ) : item.externalConversationId ? (
                        <span className="flex flex-wrap items-center gap-x-2">
                            <span className="font-semibold">
                                {t("memoryReview.evidenceExternal")}
                            </span>
                            <Link
                                href={`/settings/imports/conversations/${item.externalConversationId}`}
                                className="font-semibold text-blue-600 hover:underline dark:text-blue-300"
                                data-testid="memory-evidence-source-link"
                            >
                                {t("memoryReview.evidenceViewSource")}
                            </Link>
                        </span>
                    ) : (
                        <span className="font-semibold">
                            {t("memoryReview.evidenceExternal")}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}

function MemoryRowHeader({ row }: { row: MemoryRowView }) {
    const { t } = useLanguage();
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <span
                className={`${badgeClass} bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`}
            >
                {t(kindLabelKey(row.kind))}
            </span>
            {row.sensitivity === "sensitive" && (
                <span
                    className={`${badgeClass} bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200`}
                    data-testid="memory-sensitive-badge"
                >
                    {t("memoryReview.sensitiveBadge")}
                </span>
            )}
            {row.status === "manual_review_required" && (
                <span
                    className={`${badgeClass} bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200`}
                    data-testid="memory-individual-review-badge"
                >
                    {t("memoryReview.needsIndividualReview")}
                </span>
            )}
            {row.pinned && (
                <span
                    className={`${badgeClass} bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200`}
                    data-testid="memory-pinned-badge"
                >
                    {t("memoryReview.pinnedBadge")}
                </span>
            )}
            {row.expiresAt && (
                <span className="text-[11px] font-medium text-zinc-400">
                    {interpolate(t("memoryReview.expires"), {
                        date: new Date(row.expiresAt).toLocaleDateString(),
                    })}
                </span>
            )}
        </div>
    );
}

export function MemoryReviewSettings() {
    const { t } = useLanguage();
    const [settingsState, setSettingsState] = useState<SettingsState>({
        kind: "loading",
    });
    const [listState, setListState] = useState<ListState>({ kind: "loading" });
    const [loadingMore, setLoadingMore] = useState(false);
    // Set when any flag-gated call answers MEMORY_FEATURE_DISABLED. The list
    // itself is never gated, so the page keeps rendering stored memories.
    const [featureDisabled, setFeatureDisabled] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [conflictId, setConflictId] = useState<string | null>(null);
    const [rowError, setRowError] = useState<{
        id: string;
        kind: "validation" | "generic";
    } | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editStatement, setEditStatement] = useState("");
    const [editParkedNotice, setEditParkedNotice] = useState(false);
    const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
    const [bulkBusy, setBulkBusy] = useState(false);
    const [bulkResult, setBulkResult] = useState<{
        approved: number;
        skipped: number;
    } | null>(null);

    const [createKind, setCreateKind] = useState<MemoryKind>("preference");
    const [createStatement, setCreateStatement] = useState("");
    const [createGrounds, setCreateGrounds] = useState("");
    const [createSensitive, setCreateSensitive] = useState(false);
    const [createBusy, setCreateBusy] = useState(false);
    const [createConflict, setCreateConflict] = useState(false);
    const [createError, setCreateError] = useState<
        "validation" | "generic" | null
    >(null);
    const [createSuccess, setCreateSuccess] = useState(false);

    const [exportBusy, setExportBusy] = useState(false);
    const [exportError, setExportError] = useState<
        "reauth" | "generic" | null
    >(null);
    const [deleteAllText, setDeleteAllText] = useState("");
    const [deleteAllBusy, setDeleteAllBusy] = useState(false);
    const [deleteAllError, setDeleteAllError] = useState<
        "reauth" | "generic" | null
    >(null);
    const [deleteAllDone, setDeleteAllDone] = useState(false);

    const loadSettings = useCallback(async () => {
        try {
            const response = await fetch("/api/memories/settings", {
                cache: "no-store",
            });
            if (response.status === 401) {
                setSettingsState({ kind: "unauthenticated" });
                return;
            }
            if (!response.ok) {
                setSettingsState({ kind: "error" });
                return;
            }
            const settings = (await response.json()) as MemorySettings;
            setSettingsState({ kind: "ready", settings, saving: false });
        } catch {
            setSettingsState({ kind: "error" });
        }
    }, []);

    const loadMemories = useCallback(
        async ({ append = false }: { append?: boolean } = {}): Promise<
            MemoryRowView[] | null
        > => {
            const offset =
                append && listState.kind === "ready"
                    ? listState.rows.length
                    : 0;
            try {
                const response = await fetch(
                    `/api/memories?offset=${offset}&limit=${PAGE_SIZE}`,
                    { cache: "no-store" }
                );
                if (!response.ok) {
                    setListState({ kind: "error" });
                    return null;
                }
                const body = (await response.json()) as {
                    total: number;
                    memories: MemoryRowView[];
                };
                const nextRows = Array.isArray(body.memories)
                    ? body.memories
                    : [];
                let combined: MemoryRowView[] = nextRows;
                setListState((current) => {
                    combined =
                        append && current.kind === "ready"
                            ? [...current.rows, ...nextRows]
                            : nextRows;
                    return {
                        kind: "ready",
                        total: body.total,
                        rows: combined,
                    };
                });
                return combined;
            } catch {
                setListState({ kind: "error" });
                return null;
            }
        },
        [listState]
    );

    useEffect(() => {
        queueMicrotask(() => {
            void loadSettings();
            void loadMemories();
        });
        // Mount-only: mutation handlers reload explicitly, and loadMemories'
        // identity changes with its own state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleGatedFailure = useCallback((failure: ApiFailure) => {
        if (failure.code === "MEMORY_FEATURE_DISABLED") {
            setFeatureDisabled(true);
            return true;
        }
        return false;
    }, []);

    const saveSettings = useCallback(
        async (patch: Partial<MemorySettings>) => {
            if (settingsState.kind !== "ready" || settingsState.saving) return;
            const next = { ...settingsState.settings, ...patch };
            setSettingsState({ kind: "ready", settings: next, saving: true });
            const result = await callApi("/api/memories/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(next),
            });
            if (result.ok) {
                setSettingsState({
                    kind: "ready",
                    settings: result.body as MemorySettings,
                    saving: false,
                });
                return;
            }
            // Roll back to what the server last confirmed.
            setSettingsState({
                kind: "ready",
                settings: settingsState.settings,
                saving: false,
            });
        },
        [settingsState]
    );

    const patchMemory = useCallback(
        async (
            memoryId: string,
            body: Record<string, unknown>,
            { wasActive = false }: { wasActive?: boolean } = {}
        ) => {
            setBusyId(memoryId);
            setRowError(null);
            setBulkResult(null);
            const result = await callApi(`/api/memories/${memoryId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            setBusyId(null);
            if (result.ok) {
                setConflictId(null);
                setEditingId(null);
                const rows = await loadMemories();
                if (wasActive && body.action === "edit") {
                    const updated = rows?.find((row) => row.id === memoryId);
                    setEditParkedNotice(
                        updated?.status === "manual_review_required"
                    );
                }
                return;
            }
            if (handleGatedFailure(result.failure)) return;
            if (result.failure.code === "MEMORY_ITEM_CONFLICT") {
                setConflictId(memoryId);
                return;
            }
            if (result.failure.code === "MEMORY_VALIDATION_FAILED") {
                setRowError({ id: memoryId, kind: "validation" });
                return;
            }
            if (result.failure.code === "MEMORY_ITEM_STATE") {
                // The row changed underneath the page; re-sync silently.
                void loadMemories();
                return;
            }
            setRowError({ id: memoryId, kind: "generic" });
        },
        [handleGatedFailure, loadMemories]
    );

    const deleteMemory = useCallback(
        async (memoryId: string) => {
            setBusyId(memoryId);
            const result = await callApi(`/api/memories/${memoryId}`, {
                method: "DELETE",
            });
            setBusyId(null);
            setArmedDeleteId(null);
            if (result.ok) {
                void loadMemories();
            }
        },
        [loadMemories]
    );

    const bulkApprove = useCallback(async () => {
        setBulkBusy(true);
        setBulkResult(null);
        const result = await callApi("/api/memories/bulk-approve", {
            method: "POST",
        });
        setBulkBusy(false);
        if (result.ok) {
            setBulkResult(
                result.body as { approved: number; skipped: number }
            );
            void loadMemories();
            return;
        }
        handleGatedFailure(result.failure);
    }, [handleGatedFailure, loadMemories]);

    const submitCreate = useCallback(
        async (resolveConflict: boolean) => {
            setCreateBusy(true);
            setCreateError(null);
            setCreateSuccess(false);
            const result = await callApi("/api/memories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    kind: createKind,
                    statement: createStatement.trim(),
                    groundsText: createGrounds.trim(),
                    ...(createSensitive
                        ? { sensitivity: "sensitive" as const }
                        : {}),
                    ...(resolveConflict
                        ? { resolveConflict: "supersede_existing" as const }
                        : {}),
                }),
            });
            setCreateBusy(false);
            if (result.ok) {
                setCreateStatement("");
                setCreateGrounds("");
                setCreateSensitive(false);
                setCreateConflict(false);
                setCreateSuccess(true);
                void loadMemories();
                return;
            }
            if (handleGatedFailure(result.failure)) return;
            if (result.failure.code === "MEMORY_ITEM_CONFLICT") {
                setCreateConflict(true);
                return;
            }
            setCreateError(
                result.failure.code === "MEMORY_VALIDATION_FAILED"
                    ? "validation"
                    : "generic"
            );
        },
        [
            createGrounds,
            createKind,
            createSensitive,
            createStatement,
            handleGatedFailure,
            loadMemories,
        ]
    );

    /**
     * Fetched rather than navigated to, unlike the imported-data export: this
     * endpoint is step-up gated, and a plain navigation would paint a raw
     * JSON 428 body over the page instead of telling the user to sign in
     * again. The server still streams the document; buffering it here is a
     * client-side concern and memory statements are bounded (§8.4).
     */
    const downloadExport = useCallback(async () => {
        setExportBusy(true);
        setExportError(null);
        try {
            const response = await fetch("/api/memories/export", {
                cache: "no-store",
            });
            if (!response.ok) {
                setExportError(response.status === 428 ? "reauth" : "generic");
                return;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "tomverse-memories.json";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        } catch {
            setExportError("generic");
        } finally {
            setExportBusy(false);
        }
    }, []);

    const deleteAll = useCallback(async () => {
        setDeleteAllBusy(true);
        setDeleteAllError(null);
        const result = await callApi("/api/memories/delete-all", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                confirm: true,
                confirmationText: DELETE_ALL_CONFIRMATION,
            }),
        });
        setDeleteAllBusy(false);
        if (result.ok) {
            setDeleteAllText("");
            setDeleteAllDone(true);
            void loadMemories();
            return;
        }
        setDeleteAllError(
            result.failure.status === 428 ? "reauth" : "generic"
        );
    }, [loadMemories]);

    const groups = useMemo(() => {
        if (listState.kind !== "ready") {
            return { review: [], active: [], archived: [] } as Record<
                "review" | "active" | "archived",
                MemoryRowView[]
            >;
        }
        return {
            review: listState.rows.filter((row) =>
                (REVIEW_STATUSES as readonly string[]).includes(row.status)
            ),
            active: listState.rows.filter((row) => row.status === "active"),
            archived: listState.rows.filter((row) =>
                (ARCHIVED_STATUSES as readonly string[]).includes(row.status)
            ),
        };
    }, [listState]);

    const renderRowError = (rowId: string) =>
        rowError?.id === rowId && (
            <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs leading-5 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                {rowError.kind === "validation"
                    ? t("memoryReview.validationFailed")
                    : t("memoryReview.errorGeneric")}
            </p>
        );

    const renderConflict = (rowId: string) =>
        conflictId === rowId && (
            <div
                className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 dark:border-amber-900/60 dark:bg-amber-950/20"
                data-testid="memory-conflict"
            >
                <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
                    {t("memoryReview.conflictNotice")}
                </p>
                <div className="mt-1.5 flex gap-2">
                    <button
                        type="button"
                        className={smallButtonClass}
                        data-testid="memory-conflict-replace"
                        disabled={busyId !== null}
                        onClick={() =>
                            void patchMemory(rowId, {
                                action: "approve",
                                resolveConflict: "supersede_existing",
                            })
                        }
                    >
                        {t("memoryReview.conflictReplace")}
                    </button>
                    <button
                        type="button"
                        className={smallButtonClass}
                        onClick={() => setConflictId(null)}
                    >
                        {t("memoryReview.cancel")}
                    </button>
                </div>
            </div>
        );

    const renderEditor = (row: MemoryRowView) =>
        editingId === row.id ? (
            <div className="mt-2">
                <textarea
                    className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm leading-6 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    rows={2}
                    maxLength={MEMORY_STATEMENT_MAX_CODE_POINTS}
                    value={editStatement}
                    data-testid="memory-edit-statement"
                    onChange={(event) => setEditStatement(event.target.value)}
                />
                <div className="mt-1.5 flex gap-2">
                    <button
                        type="button"
                        className={smallButtonClass}
                        data-testid="memory-edit-save"
                        disabled={
                            busyId !== null ||
                            editStatement.trim().length === 0
                        }
                        onClick={() =>
                            void patchMemory(
                                row.id,
                                {
                                    action: "edit",
                                    statement: editStatement.trim(),
                                },
                                { wasActive: row.status === "active" }
                            )
                        }
                    >
                        <Check className="h-3.5 w-3.5" />
                        {t("memoryReview.save")}
                    </button>
                    <button
                        type="button"
                        className={smallButtonClass}
                        onClick={() => setEditingId(null)}
                    >
                        <X className="h-3.5 w-3.5" />
                        {t("memoryReview.cancel")}
                    </button>
                </div>
            </div>
        ) : (
            <p className="mt-1 break-words text-sm leading-6 text-zinc-900 dark:text-zinc-100">
                {row.statement}
            </p>
        );

    const renderDeleteButton = (row: MemoryRowView) => (
        <button
            type="button"
            className={smallButtonClass}
            data-testid="memory-delete"
            disabled={busyId !== null}
            onClick={() => {
                if (armedDeleteId === row.id) {
                    void deleteMemory(row.id);
                    return;
                }
                setArmedDeleteId(row.id);
            }}
        >
            <Trash2 className="h-3.5 w-3.5" />
            {armedDeleteId === row.id
                ? t("memoryReview.deleteArmed")
                : t("memoryReview.delete")}
        </button>
    );

    if (settingsState.kind === "unauthenticated") {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-10">
                <section className={sectionClass} data-testid="memory-signin">
                    <h1 className="text-lg font-bold">
                        {t("memoryReview.pageTitle")}
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        {t("memoryReview.signInRequired")}
                    </p>
                    <Link
                        href="/auth/signin"
                        className={`${primaryButtonClass} mt-4`}
                    >
                        {t("auth.login")}
                    </Link>
                </section>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
            <div>
                <Link
                    href="/chat"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    data-testid="memory-back"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("memoryReview.backToChat")}
                </Link>
                <h1 className="mt-3 text-xl font-bold">
                    {t("memoryReview.pageTitle")}
                </h1>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("memoryReview.pageDescription")}
                </p>
            </div>

            <section className={sectionClass} data-testid="memory-privacy-note">
                <p className="text-sm leading-6 text-zinc-500">
                    {t("memoryReview.privacyNote")}
                </p>
            </section>

            {featureDisabled && (
                <section
                    className={sectionClass}
                    data-testid="memory-disabled-banner"
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
                        <p className="text-sm leading-6 text-zinc-500">
                            {t("memoryReview.disabledNotice")}
                        </p>
                    </div>
                </section>
            )}

            <section className={sectionClass} data-testid="memory-settings-card">
                <h2 className="text-sm font-bold">
                    {t("memoryReview.settingsTitle")}
                </h2>
                {settingsState.kind === "loading" && (
                    <Loader2 className="mt-3 h-4 w-4 animate-spin text-zinc-400" />
                )}
                {settingsState.kind === "error" && (
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        {t("memoryReview.errorGeneric")}
                    </p>
                )}
                {settingsState.kind === "ready" && (
                    <div className="mt-3 space-y-3">
                        <label className="flex items-start gap-2.5">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                data-testid="memory-master-toggle"
                                checked={settingsState.settings.masterEnabled}
                                disabled={settingsState.saving}
                                onChange={(event) =>
                                    void saveSettings({
                                        masterEnabled: event.target.checked,
                                    })
                                }
                            />
                            <span>
                                <span className="block text-sm font-semibold">
                                    {t("memoryReview.masterToggleLabel")}
                                </span>
                                <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                                    {t("memoryReview.masterToggleDescription")}
                                </span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2.5">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                data-testid="memory-style-toggle"
                                checked={settingsState.settings.styleEnabled}
                                disabled={settingsState.saving}
                                onChange={(event) =>
                                    void saveSettings({
                                        styleEnabled: event.target.checked,
                                    })
                                }
                            />
                            <span>
                                <span className="block text-sm font-semibold">
                                    {t("memoryReview.styleToggleLabel")}
                                </span>
                                <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                                    {t("memoryReview.styleToggleDescription")}
                                </span>
                            </span>
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold">
                                {t("memoryReview.defaultModeLabel")}
                            </span>
                            <select
                                className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                                data-testid="memory-default-mode"
                                value={
                                    settingsState.settings
                                        .defaultConversationMode
                                }
                                disabled={settingsState.saving}
                                onChange={(event) =>
                                    void saveSettings({
                                        defaultConversationMode:
                                            event.target.value === "off"
                                                ? "off"
                                                : "on",
                                    })
                                }
                            >
                                <option value="on">
                                    {t("memoryReview.defaultModeOn")}
                                </option>
                                <option value="off">
                                    {t("memoryReview.defaultModeOff")}
                                </option>
                            </select>
                        </div>
                    </div>
                )}
            </section>

            {/* Extraction start sits between the settings and the queue it
                fills: the launcher removes itself when the rollout flag is off
                (its endpoint is gated), so a rollback leaves the review and
                delete surfaces exactly as they were (§15). */}
            <MemoryExtractionLauncher />

            <section className={sectionClass} data-testid="memory-review-queue">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-bold">
                        {t("memoryReview.reviewTitle")}
                    </h2>
                    <button
                        type="button"
                        className={secondaryButtonClass}
                        data-testid="memory-bulk-approve"
                        disabled={
                            featureDisabled ||
                            bulkBusy ||
                            groups.review.length === 0
                        }
                        onClick={() => void bulkApprove()}
                    >
                        {bulkBusy && (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        {t("memoryReview.bulkApprove")}
                    </button>
                </div>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("memoryReview.reviewDescription")}
                </p>
                {bulkResult && (
                    <p
                        className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs leading-5 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200"
                        data-testid="memory-bulk-result"
                    >
                        {interpolate(t("memoryReview.bulkResult"), {
                            approved: bulkResult.approved,
                            skipped: bulkResult.skipped,
                        })}
                    </p>
                )}
                {listState.kind === "loading" && (
                    <Loader2 className="mt-3 h-4 w-4 animate-spin text-zinc-400" />
                )}
                {listState.kind === "error" && (
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        {t("memoryReview.errorGeneric")}
                    </p>
                )}
                {listState.kind === "ready" &&
                    (groups.review.length === 0 ? (
                        <p
                            className="mt-2 text-sm leading-6 text-zinc-500"
                            data-testid="memory-review-empty"
                        >
                            {t("memoryReview.reviewEmpty")}
                        </p>
                    ) : (
                        <ul className="mt-3 space-y-2">
                            {groups.review.map((row) => (
                                <li
                                    key={row.id}
                                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900"
                                    data-testid="memory-review-row"
                                >
                                    <MemoryRowHeader row={row} />
                                    {renderEditor(row)}
                                    <EvidenceList evidence={row.evidence} />
                                    {renderConflict(row.id)}
                                    {renderRowError(row.id)}
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className={smallButtonClass}
                                            data-testid="memory-approve"
                                            disabled={
                                                featureDisabled ||
                                                busyId !== null
                                            }
                                            onClick={() =>
                                                void patchMemory(row.id, {
                                                    action: "approve",
                                                })
                                            }
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                            {t("memoryReview.approve")}
                                        </button>
                                        <button
                                            type="button"
                                            className={smallButtonClass}
                                            data-testid="memory-reject"
                                            disabled={
                                                featureDisabled ||
                                                busyId !== null
                                            }
                                            onClick={() =>
                                                void patchMemory(row.id, {
                                                    action: "reject",
                                                })
                                            }
                                        >
                                            <X className="h-3.5 w-3.5" />
                                            {t("memoryReview.reject")}
                                        </button>
                                        {editingId !== row.id && (
                                            <button
                                                type="button"
                                                className={smallButtonClass}
                                                data-testid="memory-edit"
                                                disabled={
                                                    featureDisabled ||
                                                    busyId !== null
                                                }
                                                onClick={() => {
                                                    setEditingId(row.id);
                                                    setEditStatement(
                                                        row.statement
                                                    );
                                                }}
                                            >
                                                {t("memoryReview.edit")}
                                            </button>
                                        )}
                                        {renderDeleteButton(row)}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ))}
            </section>

            <section className={sectionClass} data-testid="memory-active-list">
                <h2 className="text-sm font-bold">
                    {t("memoryReview.activeTitle")}
                </h2>
                {editParkedNotice && (
                    <p
                        className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
                        data-testid="memory-edit-parked-notice"
                    >
                        {t("memoryReview.editParkedNotice")}
                    </p>
                )}
                {listState.kind === "ready" &&
                    (groups.active.length === 0 ? (
                        <p className="mt-2 text-sm leading-6 text-zinc-500">
                            {t("memoryReview.activeEmpty")}
                        </p>
                    ) : (
                        <ul className="mt-3 space-y-2">
                            {groups.active.map((row) => (
                                <li
                                    key={row.id}
                                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900"
                                    data-testid="memory-active-row"
                                >
                                    <MemoryRowHeader row={row} />
                                    {renderEditor(row)}
                                    <EvidenceList evidence={row.evidence} />
                                    {renderConflict(row.id)}
                                    {renderRowError(row.id)}
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className={smallButtonClass}
                                            data-testid="memory-pin-toggle"
                                            disabled={
                                                featureDisabled ||
                                                busyId !== null
                                            }
                                            onClick={() =>
                                                void patchMemory(row.id, {
                                                    action: row.pinned
                                                        ? "unpin"
                                                        : "pin",
                                                })
                                            }
                                        >
                                            {row.pinned ? (
                                                <PinOff className="h-3.5 w-3.5" />
                                            ) : (
                                                <Pin className="h-3.5 w-3.5" />
                                            )}
                                            {row.pinned
                                                ? t("memoryReview.unpin")
                                                : t("memoryReview.pin")}
                                        </button>
                                        {editingId !== row.id && (
                                            <button
                                                type="button"
                                                className={smallButtonClass}
                                                data-testid="memory-edit"
                                                disabled={
                                                    featureDisabled ||
                                                    busyId !== null
                                                }
                                                onClick={() => {
                                                    setEditingId(row.id);
                                                    setEditStatement(
                                                        row.statement
                                                    );
                                                }}
                                            >
                                                {t("memoryReview.edit")}
                                            </button>
                                        )}
                                        {renderDeleteButton(row)}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ))}
            </section>

            {groups.archived.length > 0 && (
                <section
                    className={sectionClass}
                    data-testid="memory-archived-list"
                >
                    <h2 className="text-sm font-bold">
                        {t("memoryReview.archivedTitle")}
                    </h2>
                    <ul className="mt-3 space-y-2">
                        {groups.archived.map((row) => (
                            <li
                                key={row.id}
                                className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 opacity-80 dark:border-zinc-800 dark:bg-zinc-900"
                                data-testid="memory-archived-row"
                            >
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <StatusBadge status={row.status} />
                                    <span
                                        className={`${badgeClass} bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`}
                                    >
                                        {t(kindLabelKey(row.kind))}
                                    </span>
                                </div>
                                <p className="mt-1 break-words text-sm leading-6 text-zinc-500">
                                    {row.statement}
                                </p>
                                <div className="mt-2">
                                    {renderDeleteButton(row)}
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {listState.kind === "ready" &&
                listState.rows.length < listState.total && (
                    <button
                        type="button"
                        className={`${secondaryButtonClass} w-full`}
                        data-testid="memory-load-more"
                        disabled={loadingMore}
                        onClick={async () => {
                            setLoadingMore(true);
                            await loadMemories({ append: true });
                            setLoadingMore(false);
                        }}
                    >
                        {loadingMore && (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        {t("memoryReview.loadMore")}
                    </button>
                )}

            <section className={sectionClass} data-testid="memory-create-form">
                <h2 className="text-sm font-bold">
                    {t("memoryReview.createTitle")}
                </h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("memoryReview.createDescription")}
                </p>
                <div className="mt-3 space-y-3">
                    <label className="block">
                        <span className="text-sm font-semibold">
                            {t("memoryReview.createKindLabel")}
                        </span>
                        <select
                            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                            data-testid="memory-create-kind"
                            value={createKind}
                            onChange={(event) =>
                                setCreateKind(
                                    event.target.value as MemoryKind
                                )
                            }
                        >
                            <optgroup
                                label={t("memoryReview.kindGroupFactual")}
                            >
                                {FACTUAL_MEMORY_KINDS.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {t(kindLabelKey(kind))}
                                    </option>
                                ))}
                            </optgroup>
                            <optgroup label={t("memoryReview.kindGroupStyle")}>
                                {STYLE_MEMORY_KINDS.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {t(kindLabelKey(kind))}
                                    </option>
                                ))}
                            </optgroup>
                        </select>
                    </label>
                    <label className="block">
                        <span className="text-sm font-semibold">
                            {t("memoryReview.createStatementLabel")}
                        </span>
                        <textarea
                            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-base leading-6 text-zinc-900 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                            rows={2}
                            maxLength={MEMORY_STATEMENT_MAX_CODE_POINTS}
                            placeholder={t(
                                "memoryReview.createStatementPlaceholder"
                            )}
                            data-testid="memory-create-statement"
                            value={createStatement}
                            onChange={(event) =>
                                setCreateStatement(event.target.value)
                            }
                        />
                    </label>
                    <label className="block">
                        <span className="text-sm font-semibold">
                            {t("memoryReview.createGroundsLabel")}
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                            {t("memoryReview.createGroundsDescription")}
                        </span>
                        <textarea
                            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-base leading-6 text-zinc-900 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                            rows={2}
                            maxLength={2000}
                            data-testid="memory-create-grounds"
                            value={createGrounds}
                            onChange={(event) =>
                                setCreateGrounds(event.target.value)
                            }
                        />
                    </label>
                    <label className="flex items-start gap-2">
                        <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4"
                            data-testid="memory-create-sensitive"
                            checked={createSensitive}
                            onChange={(event) =>
                                setCreateSensitive(event.target.checked)
                            }
                        />
                        <span className="text-sm leading-5">
                            {t("memoryReview.createSensitiveLabel")}
                        </span>
                    </label>
                    {createConflict && (
                        <div
                            className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 dark:border-amber-900/60 dark:bg-amber-950/20"
                            data-testid="memory-create-conflict"
                        >
                            <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
                                {t("memoryReview.conflictNotice")}
                            </p>
                            <button
                                type="button"
                                className={`${smallButtonClass} mt-1.5`}
                                data-testid="memory-create-conflict-replace"
                                disabled={createBusy}
                                onClick={() => void submitCreate(true)}
                            >
                                {t("memoryReview.conflictReplace")}
                            </button>
                        </div>
                    )}
                    {createError && (
                        <p
                            className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs leading-5 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200"
                            data-testid="memory-create-error"
                        >
                            {createError === "validation"
                                ? t("memoryReview.validationFailed")
                                : t("memoryReview.errorGeneric")}
                        </p>
                    )}
                    {createSuccess && (
                        <p
                            className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs leading-5 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200"
                            data-testid="memory-create-success"
                        >
                            {t("memoryReview.createSuccess")}
                        </p>
                    )}
                    <button
                        type="button"
                        className={primaryButtonClass}
                        data-testid="memory-create-submit"
                        disabled={
                            featureDisabled ||
                            createBusy ||
                            createStatement.trim().length === 0 ||
                            createGrounds.trim().length === 0
                        }
                        onClick={() => void submitCreate(false)}
                    >
                        {createBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Plus className="h-4 w-4" />
                        )}
                        {t("memoryReview.createSubmit")}
                    </button>
                </div>
            </section>

            <section className={sectionClass} data-testid="memory-export-card">
                <h2 className="text-sm font-bold">
                    {t("memoryReview.exportTitle")}
                </h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("memoryReview.exportDescription")}
                </p>
                {exportError && (
                    <p
                        className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs leading-5 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200"
                        data-testid="memory-export-error"
                    >
                        {exportError === "reauth"
                            ? t("memoryReview.reauthRequired")
                            : t("memoryReview.errorGeneric")}
                    </p>
                )}
                <button
                    type="button"
                    className={`${secondaryButtonClass} mt-3`}
                    data-testid="memory-export"
                    disabled={exportBusy}
                    onClick={() => void downloadExport()}
                >
                    {exportBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Download className="h-4 w-4" />
                    )}
                    {t("memoryReview.exportDownload")}
                </button>
            </section>

            <section
                className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-950/70 dark:bg-red-950/20"
                data-testid="memory-danger-zone"
            >
                <h2 className="text-sm font-bold text-red-700 dark:text-red-300">
                    {t("memoryReview.deleteAllTitle")}
                </h2>
                <p className="mt-1 text-sm leading-6 text-red-700/80 dark:text-red-200/80">
                    {t("memoryReview.deleteAllDescription")}
                </p>
                <p className="mt-2 text-xs leading-5 text-red-700/80 dark:text-red-200/80">
                    {t("memoryReview.deleteAllImportsNote")}
                </p>
                {deleteAllDone && (
                    <p
                        className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs leading-5 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200"
                        data-testid="memory-delete-all-done"
                    >
                        {t("memoryReview.deleteAllDone")}
                    </p>
                )}
                {deleteAllError && (
                    <p
                        className="mt-2 rounded-lg border border-red-300 bg-white px-2.5 py-1.5 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-zinc-900 dark:text-red-200"
                        data-testid="memory-delete-all-error"
                    >
                        {deleteAllError === "reauth"
                            ? t("memoryReview.reauthRequired")
                            : t("memoryReview.errorGeneric")}
                    </p>
                )}
                <label className="mt-3 block">
                    <span className="text-xs font-semibold text-red-700 dark:text-red-200">
                        {interpolate(t("memoryReview.deleteAllConfirmLabel"), {
                            phrase: DELETE_ALL_CONFIRMATION,
                        })}
                    </span>
                    <input
                        type="text"
                        className="mt-1 w-full rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-base text-zinc-900 sm:text-sm dark:border-red-900/60 dark:bg-zinc-900 dark:text-zinc-100"
                        data-testid="memory-delete-all-confirmation"
                        value={deleteAllText}
                        autoComplete="off"
                        onChange={(event) => {
                            setDeleteAllText(event.target.value);
                            setDeleteAllDone(false);
                        }}
                    />
                </label>
                <button
                    type="button"
                    className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                    data-testid="memory-delete-all"
                    disabled={
                        deleteAllBusy ||
                        deleteAllText.trim() !== DELETE_ALL_CONFIRMATION
                    }
                    onClick={() => void deleteAll()}
                >
                    {deleteAllBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Trash2 className="h-4 w-4" />
                    )}
                    {t("memoryReview.deleteAllSubmit")}
                </button>
            </section>
        </div>
    );
}
