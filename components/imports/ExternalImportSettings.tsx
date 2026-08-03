"use client";

import Link from "next/link";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    AlertTriangle,
    ArrowLeft,
    CheckCircle2,
    FileArchive,
    Loader2,
    Trash2,
    Upload,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { EXTERNAL_IMPORT_PARSER_VERSION } from "@/lib/externalImportAdapters";
import type { ParsedExternalConversation } from "@/lib/externalImportAdapters/types";
import {
    buildBatchPayloads,
    type ImportPreview,
} from "@/lib/externalImportPipeline";
import { EXTERNAL_IMPORT_STORAGE_LIMITS } from "@/lib/externalImportLimits";
import type { WorkerResponse } from "@/lib/workers/externalImportWorker";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

/**
 * /settings/imports — the Release A import wizard and history.
 *
 * docs/policy/external-conversation-import-and-memory.md §5, §21.
 *
 * The export archive is opened by lib/workers/externalImportWorker.ts inside
 * the browser; this component only ever uploads the normalized text of the
 * conversations the user selects. Whether the feature is available is
 * decided by the server: the capacity endpoint is the flag probe
 * (403 EXTERNAL_IMPORT_DISABLED → the wizard is closed), while the history
 * list and delete stay reachable so a rollback never strands imported data.
 */

const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const providerLabel = (provider: string) =>
    provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : provider;

const IMPORT_STATUS_KEYS: Record<string, string> = {
    completed: "externalImport.statusCompleted",
    failed: "externalImport.statusFailed",
    cancelled: "externalImport.statusCancelled",
    staging: "externalImport.statusStaging",
};

type Capacity = {
    limits: {
        maxNormalizedTextBytes: number;
        maxExternalConversations: number;
        maxExternalMessages: number;
    };
    usage: {
        normalizedTextBytes: number;
        externalConversations: number;
        externalMessages: number;
    };
    remaining: {
        normalizedTextBytes: number;
        externalConversations: number;
        externalMessages: number;
    };
};

type CapacityState =
    | { kind: "loading" }
    | { kind: "ready"; capacity: Capacity }
    | { kind: "disabled" }
    | { kind: "unauthenticated" }
    | { kind: "error" };

export type ImportHistoryRow = {
    id: string;
    provider: string;
    status: string;
    failureCode: string | null;
    conversationCount: number;
    messageCount: number;
    normalizedBytes: number;
    truncationCount: number;
    duplicateCount: number;
    createdAt: string;
    completedAt: string | null;
};

type HistoryState =
    | { kind: "loading" }
    | { kind: "ready"; imports: ImportHistoryRow[] }
    | { kind: "unauthenticated" }
    | { kind: "error" };

type StagedTotals = {
    importId: string;
    stagedConversationIds: string[];
    stagedConversations: number;
    duplicatesSkipped: number;
    truncatedMessages: number;
};

/**
 * Client wizard states. `desktop_recommended` is the client-side
 * EXTERNAL_IMPORT_DESKTOP_RECOMMENDED state from policy §5.2 — it is not a
 * server error code.
 */
type WizardPhase =
    | { kind: "idle" }
    | { kind: "parsing"; conversationsFound: number }
    | { kind: "parse_failed"; reason: string }
    | { kind: "desktop_recommended" }
    | { kind: "preview"; preview: ImportPreview }
    | { kind: "uploading"; sentBatches: number; totalBatches: number }
    | {
          kind: "upload_failed";
          errorCode: string | null;
          preview: ImportPreview;
      }
    | { kind: "staged"; totals: StagedTotals }
    | { kind: "finalizing"; totals: StagedTotals }
    | {
          kind: "finalize_failed";
          errorCode: string | null;
          totals: StagedTotals;
      }
    | { kind: "completed"; finalizedConversations: number };

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

export function ExternalImportSettings() {
    const { t } = useLanguage();
    const [capacityState, setCapacityState] = useState<CapacityState>({
        kind: "loading",
    });
    const [historyState, setHistoryState] = useState<HistoryState>({
        kind: "loading",
    });
    const [phase, setPhase] = useState<WizardPhase>({ kind: "idle" });
    const [parsedConversations, setParsedConversations] = useState<
        ParsedExternalConversation[]
    >([]);
    const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
    const [truncationApproved, setTruncationApproved] = useState(false);
    const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const workerRef = useRef<Worker | null>(null);
    const providerRef = useRef<"chatgpt" | "claude" | null>(null);
    const uploadStateRef = useRef<{
        importId: string | null;
        nextSequence: number;
        stagedConversationIds: string[];
        stagedConversations: number;
        duplicatesSkipped: number;
        truncatedMessages: number;
    } | null>(null);
    const idempotencyKeyRef = useRef<string>("");
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const loadCapacity = useCallback(async () => {
        try {
            const response = await fetch("/api/imports/external/capacity", {
                cache: "no-store",
            });
            if (response.status === 401) {
                setCapacityState({ kind: "unauthenticated" });
                return;
            }
            if (response.status === 403) {
                setCapacityState({ kind: "disabled" });
                return;
            }
            if (!response.ok) {
                setCapacityState({ kind: "error" });
                return;
            }
            const capacity = (await response.json()) as Capacity;
            setCapacityState({ kind: "ready", capacity });
        } catch {
            setCapacityState({ kind: "error" });
        }
    }, []);

    const loadHistory = useCallback(async () => {
        try {
            const response = await fetch("/api/imports/external", {
                cache: "no-store",
            });
            if (response.status === 401) {
                setHistoryState({ kind: "unauthenticated" });
                return;
            }
            if (!response.ok) {
                setHistoryState({ kind: "error" });
                return;
            }
            const body = (await response.json()) as {
                imports: ImportHistoryRow[];
            };
            setHistoryState({
                kind: "ready",
                imports: Array.isArray(body.imports) ? body.imports : [],
            });
        } catch {
            setHistoryState({ kind: "error" });
        }
    }, []);

    useEffect(() => {
        queueMicrotask(() => {
            void loadCapacity();
            void loadHistory();
        });
    }, [loadCapacity, loadHistory]);

    useEffect(
        () => () => {
            workerRef.current?.terminate();
            workerRef.current = null;
        },
        []
    );

    const resetWizard = useCallback(() => {
        workerRef.current?.terminate();
        workerRef.current = null;
        setParsedConversations([]);
        providerRef.current = null;
        uploadStateRef.current = null;
        idempotencyKeyRef.current = "";
        setSelection(new Set());
        setTruncationApproved(false);
        setPhase({ kind: "idle" });
        if (fileInputRef.current) fileInputRef.current.value = "";
    }, []);

    const handleFileSelected = useCallback((file: File) => {
        workerRef.current?.terminate();
        const worker = new Worker(
            new URL(
                "../../lib/workers/externalImportWorker.ts",
                import.meta.url
            ),
            { type: "module" }
        );
        workerRef.current = worker;
        setPhase({ kind: "parsing", conversationsFound: 0 });

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.type === "progress") {
                setPhase((current) =>
                    current.kind === "parsing"
                        ? {
                              kind: "parsing",
                              conversationsFound: message.conversationsFound,
                          }
                        : current
                );
                return;
            }
            if (message.type === "preview") {
                setParsedConversations(message.conversations);
                providerRef.current = message.preview.provider;
                // Everything importable as-is starts selected; conversations
                // that need truncation approval join the selection only when
                // the user explicitly approves (§5.4).
                const initial = new Set<string>();
                for (const row of message.preview.conversations) {
                    if (row.importability.kind === "importable") {
                        initial.add(
                            row.conversation.rawExternalConversationId
                        );
                    }
                }
                setSelection(initial);
                setTruncationApproved(false);
                setPhase({ kind: "preview", preview: message.preview });
                trackProductEvent("external_import_parse_completed", 0, {
                    import_provider: message.preview.provider,
                });
                worker.terminate();
                workerRef.current = null;
                return;
            }
            if (message.type === "error") {
                if (message.reason === "out_of_memory") {
                    setPhase({ kind: "desktop_recommended" });
                    trackProductEvent(
                        "external_import_desktop_recommended",
                        0,
                        { import_provider: "unknown" }
                    );
                } else {
                    setPhase({ kind: "parse_failed", reason: message.reason });
                }
                trackProductEvent("external_import_parse_failed", 0, {
                    import_provider: "unknown",
                    import_failure_reason: message.reason,
                });
                worker.terminate();
                workerRef.current = null;
                return;
            }
            if (message.type === "cancelled") {
                worker.terminate();
                workerRef.current = null;
            }
        };
        worker.onerror = () => {
            setPhase({ kind: "parse_failed", reason: "worker_error" });
            trackProductEvent("external_import_parse_failed", 0, {
                import_provider: "unknown",
                import_failure_reason: "worker_error",
            });
            worker.terminate();
            workerRef.current = null;
        };
        worker.postMessage({ type: "parse", file });
    }, []);

    const cancelParsing = useCallback(() => {
        workerRef.current?.postMessage({ type: "cancel" });
        resetWizard();
    }, [resetWizard]);

    const selectedConversations = useMemo(() => {
        if (phase.kind !== "preview" && phase.kind !== "upload_failed") {
            return [];
        }
        return parsedConversations.filter((conversation) =>
            selection.has(conversation.rawExternalConversationId)
        );
    }, [phase, parsedConversations, selection]);

    const selectedBytes = useMemo(() => {
        if (phase.kind !== "preview" && phase.kind !== "upload_failed") return 0;
        const preview = phase.preview;
        let bytes = 0;
        for (const row of preview.conversations) {
            if (selection.has(row.conversation.rawExternalConversationId)) {
                bytes += row.estimatedStoredBytes;
            }
        }
        return bytes;
    }, [phase, selection]);

    const selectedMessages = useMemo(
        () =>
            selectedConversations.reduce(
                (total, conversation) => total + conversation.messages.length,
                0
            ),
        [selectedConversations]
    );

    const quotaBlocked = useMemo(() => {
        if (capacityState.kind !== "ready") return false;
        const { remaining } = capacityState.capacity;
        return (
            selectedBytes > remaining.normalizedTextBytes ||
            selectedConversations.length > remaining.externalConversations ||
            selectedMessages > remaining.externalMessages
        );
    }, [capacityState, selectedBytes, selectedConversations, selectedMessages]);

    const runUpload = useCallback(async () => {
        const provider = providerRef.current;
        const previewPhase =
            phase.kind === "preview" || phase.kind === "upload_failed"
                ? phase
                : null;
        if (!provider || !previewPhase || selectedConversations.length === 0) {
            return;
        }

        let payloads;
        try {
            payloads = buildBatchPayloads(selectedConversations);
        } catch {
            setPhase({
                kind: "upload_failed",
                errorCode: "EXTERNAL_IMPORT_PAYLOAD_TOO_LARGE",
                preview: previewPhase.preview,
            });
            return;
        }

        // Resume state is copied out of the ref and written back whole after
        // every step, so a retry after a mid-upload failure re-sends only the
        // batches the server has not acknowledged (§5.5 batch ledger).
        const resumed = uploadStateRef.current;
        let importId = resumed?.importId ?? null;
        let nextSequence = resumed?.nextSequence ?? 0;
        let stagedConversationIds = resumed?.stagedConversationIds ?? [];
        let stagedConversations = resumed?.stagedConversations ?? 0;
        let duplicatesSkipped = resumed?.duplicatesSkipped ?? 0;
        let truncatedMessages = resumed?.truncatedMessages ?? 0;
        const persist = () => {
            uploadStateRef.current = {
                importId,
                nextSequence,
                stagedConversationIds,
                stagedConversations,
                duplicatesSkipped,
                truncatedMessages,
            };
        };
        persist();

        try {
            if (!importId) {
                const created = await fetch("/api/imports/external", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        provider,
                        parserVersion: EXTERNAL_IMPORT_PARSER_VERSION,
                    }),
                });
                if (!created.ok) {
                    const body = (await created
                        .json()
                        .catch(() => null)) as { code?: string } | null;
                    setPhase({
                        kind: "upload_failed",
                        errorCode: body?.code ?? null,
                        preview: previewPhase.preview,
                    });
                    return;
                }
                const body = (await created.json()) as { importId: string };
                importId = body.importId;
                persist();
            }

            for (
                let sequence = nextSequence;
                sequence < payloads.length;
                sequence += 1
            ) {
                setPhase({
                    kind: "uploading",
                    sentBatches: sequence,
                    totalBatches: payloads.length,
                });
                const response = await fetch(
                    `/api/imports/external/${importId}/batches`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payloads[sequence]),
                    }
                );
                if (!response.ok) {
                    const body = (await response
                        .json()
                        .catch(() => null)) as { code?: string } | null;
                    setPhase({
                        kind: "upload_failed",
                        errorCode: body?.code ?? null,
                        preview: previewPhase.preview,
                    });
                    return;
                }
                const body = (await response.json()) as {
                    idempotentReplay: boolean;
                    results: Array<{
                        outcome: "staged" | "duplicate";
                        stagedConversationId?: string;
                        truncatedMessageCount: number;
                    }>;
                };
                for (const result of body.results) {
                    if (
                        result.outcome === "staged" &&
                        result.stagedConversationId
                    ) {
                        stagedConversationIds = [
                            ...stagedConversationIds,
                            result.stagedConversationId,
                        ];
                        stagedConversations += 1;
                        truncatedMessages += result.truncatedMessageCount;
                    } else if (result.outcome === "duplicate") {
                        duplicatesSkipped += 1;
                    }
                }
                nextSequence = sequence + 1;
                persist();
            }

            idempotencyKeyRef.current = crypto.randomUUID();
            setPhase({
                kind: "staged",
                totals: {
                    importId,
                    stagedConversationIds,
                    stagedConversations,
                    duplicatesSkipped,
                    truncatedMessages,
                },
            });
        } catch {
            setPhase({
                kind: "upload_failed",
                errorCode: null,
                preview: previewPhase.preview,
            });
        }
    }, [phase, selectedConversations]);

    const runFinalize = useCallback(
        async (totals: StagedTotals) => {
            setPhase({ kind: "finalizing", totals });
            try {
                const response = await fetch(
                    `/api/imports/external/${totals.importId}/finalize`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            idempotencyKey: idempotencyKeyRef.current,
                            selectedConversationIds:
                                totals.stagedConversationIds,
                        }),
                    }
                );
                if (!response.ok) {
                    const body = (await response
                        .json()
                        .catch(() => null)) as { code?: string } | null;
                    setPhase({
                        kind: "finalize_failed",
                        errorCode: body?.code ?? null,
                        totals,
                    });
                    return;
                }
                const body = (await response.json()) as {
                    finalizedConversations: number;
                };
                trackProductEvent("external_import_finalized", 0, {
                    import_provider: providerRef.current ?? "unknown",
                });
                setPhase({
                    kind: "completed",
                    finalizedConversations: body.finalizedConversations,
                });
                void loadCapacity();
                void loadHistory();
            } catch {
                setPhase({ kind: "finalize_failed", errorCode: null, totals });
            }
        },
        [loadCapacity, loadHistory]
    );

    const discardStagingImport = useCallback(
        async (importId: string) => {
            try {
                await fetch(`/api/imports/external/${importId}`, {
                    method: "DELETE",
                });
            } catch {
                // Abandoned staging is also cleared by the server TTL sweep.
            }
            resetWizard();
            void loadHistory();
        },
        [loadHistory, resetWizard]
    );

    const deleteHistoryRow = useCallback(
        async (importId: string) => {
            if (armedDeleteId !== importId) {
                setArmedDeleteId(importId);
                return;
            }
            setDeletingId(importId);
            try {
                const response = await fetch(
                    `/api/imports/external/${importId}`,
                    { method: "DELETE" }
                );
                if (response.ok) {
                    void loadCapacity();
                    await loadHistory();
                }
            } finally {
                setDeletingId(null);
                setArmedDeleteId(null);
            }
        },
        [armedDeleteId, loadCapacity, loadHistory]
    );

    const toggleConversation = useCallback(
        (id: string, importable: boolean, needsTruncation: boolean) => {
            if (!importable) return;
            if (needsTruncation && !truncationApproved) return;
            setSelection((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
        },
        [truncationApproved]
    );

    const applyTruncationApproval = useCallback(
        (approved: boolean) => {
            setTruncationApproved(approved);
            if (phase.kind !== "preview" && phase.kind !== "upload_failed") {
                return;
            }
            const preview = phase.preview;
            setSelection((current) => {
                const next = new Set(current);
                for (const row of preview.conversations) {
                    if (
                        row.importability.kind ===
                        "requires_truncation_approval"
                    ) {
                        if (approved) {
                            next.add(
                                row.conversation.rawExternalConversationId
                            );
                        } else {
                            next.delete(
                                row.conversation.rawExternalConversationId
                            );
                        }
                    }
                }
                return next;
            });
        },
        [phase]
    );

    if (capacityState.kind === "unauthenticated") {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-10">
                <section className={sectionClass}>
                    <h1 className="text-lg font-bold">
                        {t("externalImport.pageTitle")}
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        {t("externalImport.signInRequired")}
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
                    data-testid="external-import-back"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("externalImport.backToChat")}
                </Link>
                <h1 className="mt-3 text-xl font-bold">
                    {t("externalImport.pageTitle")}
                </h1>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("externalImport.pageDescription")}
                </p>
            </div>

            <section className={sectionClass} data-testid="external-import-privacy-note">
                <p className="text-sm leading-6 text-zinc-500">
                    {t("externalImport.privacyNote")}
                </p>
            </section>

            {capacityState.kind === "disabled" ? (
                <section
                    className={sectionClass}
                    data-testid="external-import-disabled"
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
                        <p className="text-sm leading-6 text-zinc-500">
                            {t("externalImport.disabledNotice")}
                        </p>
                    </div>
                </section>
            ) : (
                <>
                    {capacityState.kind === "ready" && (
                        <section
                            className={sectionClass}
                            data-testid="external-import-capacity"
                        >
                            <h2 className="text-sm font-bold">
                                {t("externalImport.capacityTitle")}
                            </h2>
                            <div className="mt-2 grid gap-1 text-sm leading-6 text-zinc-500">
                                <p>
                                    {interpolate(
                                        t("externalImport.capacityUsage"),
                                        {
                                            used: formatBytes(
                                                capacityState.capacity.usage
                                                    .normalizedTextBytes
                                            ),
                                            limit: formatBytes(
                                                capacityState.capacity.limits
                                                    .maxNormalizedTextBytes
                                            ),
                                        }
                                    )}
                                </p>
                                <p>
                                    {interpolate(
                                        t(
                                            "externalImport.capacityConversations"
                                        ),
                                        {
                                            used: capacityState.capacity.usage
                                                .externalConversations,
                                            limit: capacityState.capacity
                                                .limits
                                                .maxExternalConversations,
                                        }
                                    )}
                                </p>
                            </div>
                        </section>
                    )}

                    <section
                        className={sectionClass}
                        data-testid="external-import-wizard"
                    >
                        {phase.kind === "idle" && (
                            <div>
                                <h2 className="text-sm font-bold">
                                    {t("externalImport.selectFile")}
                                </h2>
                                <p className="mt-1 text-sm leading-6 text-zinc-500">
                                    {t("externalImport.selectFileHint")}
                                </p>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".zip,.json,application/zip,application/json"
                                    className="sr-only"
                                    data-testid="external-import-file-input"
                                    onChange={(event) => {
                                        const file =
                                            event.target.files?.[0] ?? null;
                                        if (file) handleFileSelected(file);
                                    }}
                                />
                                <button
                                    type="button"
                                    className={`${primaryButtonClass} mt-4`}
                                    data-testid="external-import-choose-file"
                                    onClick={() =>
                                        fileInputRef.current?.click()
                                    }
                                >
                                    <FileArchive className="h-4 w-4" />
                                    {t("externalImport.selectFile")}
                                </button>
                            </div>
                        )}

                        {phase.kind === "parsing" && (
                            <div data-testid="external-import-parsing">
                                <div className="flex items-center gap-2 text-sm font-semibold">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    {t("externalImport.parsing")}
                                </div>
                                <p className="mt-1 text-sm leading-6 text-zinc-500">
                                    {interpolate(
                                        t("externalImport.parsingProgress"),
                                        {
                                            conversations:
                                                phase.conversationsFound,
                                        }
                                    )}
                                </p>
                                <button
                                    type="button"
                                    className={`${secondaryButtonClass} mt-4`}
                                    onClick={cancelParsing}
                                >
                                    {t("externalImport.cancel")}
                                </button>
                            </div>
                        )}

                        {phase.kind === "desktop_recommended" && (
                            <div data-testid="external-import-desktop-recommended">
                                <div className="flex items-start gap-3">
                                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                                    <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                        {t("externalImport.desktopRecommended")}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className={`${secondaryButtonClass} mt-4`}
                                    onClick={resetWizard}
                                >
                                    {t("externalImport.startAnother")}
                                </button>
                            </div>
                        )}

                        {phase.kind === "parse_failed" && (
                            <div data-testid="external-import-parse-failed">
                                <div className="flex items-start gap-3">
                                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                                    <div>
                                        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                            {t("externalImport.parseFailed")}
                                        </p>
                                        <p className="mt-1 font-mono text-xs text-zinc-400">
                                            {phase.reason}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className={`${secondaryButtonClass} mt-4`}
                                    onClick={resetWizard}
                                >
                                    {t("externalImport.startAnother")}
                                </button>
                            </div>
                        )}

                        {(phase.kind === "preview" ||
                            phase.kind === "upload_failed") && (
                            <ImportPreviewSection
                                preview={phase.preview}
                                selection={selection}
                                truncationApproved={truncationApproved}
                                selectedBytes={selectedBytes}
                                quotaBlocked={quotaBlocked}
                                uploadErrorCode={
                                    phase.kind === "upload_failed"
                                        ? phase.errorCode
                                        : null
                                }
                                onToggleConversation={toggleConversation}
                                onTruncationApproval={applyTruncationApproval}
                                onStart={() => void runUpload()}
                                onCancel={() => {
                                    const importId =
                                        uploadStateRef.current?.importId;
                                    if (importId) {
                                        void discardStagingImport(importId);
                                    } else {
                                        resetWizard();
                                    }
                                }}
                            />
                        )}

                        {phase.kind === "uploading" && (
                            <div data-testid="external-import-uploading">
                                <div className="flex items-center gap-2 text-sm font-semibold">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    {interpolate(
                                        t("externalImport.uploading"),
                                        {
                                            sent: phase.sentBatches + 1,
                                            total: phase.totalBatches,
                                        }
                                    )}
                                </div>
                            </div>
                        )}

                        {(phase.kind === "staged" ||
                            phase.kind === "finalizing" ||
                            phase.kind === "finalize_failed") && (
                            <div data-testid="external-import-staged">
                                <h2 className="text-sm font-bold">
                                    {t("externalImport.stagedTitle")}
                                </h2>
                                <p className="mt-1 text-sm leading-6 text-zinc-500">
                                    {interpolate(
                                        t("externalImport.stagedSummary"),
                                        {
                                            staged: phase.totals
                                                .stagedConversations,
                                            duplicates:
                                                phase.totals.duplicatesSkipped,
                                        }
                                    )}
                                </p>
                                {phase.totals.truncatedMessages > 0 && (
                                    <p className="mt-1 text-sm leading-6 text-zinc-500">
                                        {interpolate(
                                            t("externalImport.stagedTruncated"),
                                            {
                                                count: phase.totals
                                                    .truncatedMessages,
                                            }
                                        )}
                                    </p>
                                )}
                                {phase.kind === "finalize_failed" && (
                                    <p className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                                        {phase.errorCode ===
                                        "EXTERNAL_IMPORT_QUOTA_EXCEEDED"
                                            ? t(
                                                  "externalImport.finalizeFailedQuota"
                                              )
                                            : phase.errorCode ===
                                                "EXTERNAL_IMPORT_STAGING_EXPIRED"
                                              ? t(
                                                    "externalImport.stagingExpired"
                                                )
                                              : t(
                                                    "externalImport.errorGeneric"
                                                )}
                                    </p>
                                )}
                                {phase.totals.stagedConversations === 0 ? (
                                    <div className="mt-4">
                                        <p className="text-sm leading-6 text-zinc-500">
                                            {t("externalImport.allDuplicates")}
                                        </p>
                                        <button
                                            type="button"
                                            className={`${secondaryButtonClass} mt-3`}
                                            onClick={() =>
                                                void discardStagingImport(
                                                    phase.totals.importId
                                                )
                                            }
                                        >
                                            {t("externalImport.startAnother")}
                                        </button>
                                    </div>
                                ) : (
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className={primaryButtonClass}
                                            data-testid="external-import-finalize"
                                            disabled={
                                                phase.kind === "finalizing"
                                            }
                                            onClick={() =>
                                                void runFinalize(phase.totals)
                                            }
                                        >
                                            {phase.kind === "finalizing" ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Upload className="h-4 w-4" />
                                            )}
                                            {phase.kind === "finalizing"
                                                ? t(
                                                      "externalImport.finalizing"
                                                  )
                                                : t("externalImport.finalize")}
                                        </button>
                                        <button
                                            type="button"
                                            className={secondaryButtonClass}
                                            disabled={
                                                phase.kind === "finalizing"
                                            }
                                            onClick={() =>
                                                void discardStagingImport(
                                                    phase.totals.importId
                                                )
                                            }
                                        >
                                            {t("externalImport.cancel")}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {phase.kind === "completed" && (
                            <div data-testid="external-import-completed">
                                <div className="flex items-start gap-3">
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-success-500" />
                                    <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                        {interpolate(
                                            t(
                                                "externalImport.importCompleted"
                                            ),
                                            {
                                                count: phase.finalizedConversations,
                                            }
                                        )}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className={`${secondaryButtonClass} mt-4`}
                                    onClick={resetWizard}
                                >
                                    {t("externalImport.startAnother")}
                                </button>
                            </div>
                        )}
                    </section>
                </>
            )}

            <section className={sectionClass} data-testid="external-import-history">
                <h2 className="text-sm font-bold">
                    {t("externalImport.historyTitle")}
                </h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("externalImport.deleteNote")}
                </p>
                {historyState.kind === "loading" && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                )}
                {historyState.kind === "error" && (
                    <p className="mt-3 text-sm leading-6 text-zinc-500">
                        {t("externalImport.errorGeneric")}
                    </p>
                )}
                {historyState.kind === "ready" &&
                    historyState.imports.length === 0 && (
                        <p
                            className="mt-3 text-sm leading-6 text-zinc-500"
                            data-testid="external-import-history-empty"
                        >
                            {t("externalImport.historyEmpty")}
                        </p>
                    )}
                {historyState.kind === "ready" &&
                    historyState.imports.length > 0 && (
                        <ul className="mt-3 space-y-2">
                            {historyState.imports.map((row) => (
                                <li
                                    key={row.id}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/60"
                                    data-testid="external-import-history-row"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                            {providerLabel(row.provider)}
                                            <span className="ml-2 text-xs font-medium text-zinc-500">
                                                {new Date(
                                                    row.createdAt
                                                ).toLocaleDateString()}
                                            </span>
                                        </p>
                                        <p className="mt-0.5 text-xs leading-5 text-zinc-500">
                                            {IMPORT_STATUS_KEYS[row.status]
                                                ? t(
                                                      IMPORT_STATUS_KEYS[
                                                          row.status
                                                      ]
                                                  )
                                                : row.status}
                                            {" · "}
                                            {interpolate(
                                                t(
                                                    "externalImport.historyConversations"
                                                ),
                                                {
                                                    count: row.conversationCount,
                                                }
                                            )}
                                            {" · "}
                                            {formatBytes(row.normalizedBytes)}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {row.status === "completed" && (
                                            <Link
                                                href={`/settings/imports/${row.id}`}
                                                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                                data-testid="external-import-history-view"
                                            >
                                                {t("externalImport.viewDetail")}
                                            </Link>
                                        )}
                                        <button
                                            type="button"
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                                            data-testid="external-import-history-delete"
                                            disabled={deletingId === row.id}
                                            onClick={() =>
                                                void deleteHistoryRow(row.id)
                                            }
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            {deletingId === row.id
                                                ? t("externalImport.deleting")
                                                : armedDeleteId === row.id
                                                  ? t(
                                                        "externalImport.deleteImportArmed"
                                                    )
                                                  : t(
                                                        "externalImport.deleteImport"
                                                    )}
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
            </section>
        </div>
    );
}

function ImportPreviewSection({
    preview,
    selection,
    truncationApproved,
    selectedBytes,
    quotaBlocked,
    uploadErrorCode,
    onToggleConversation,
    onTruncationApproval,
    onStart,
    onCancel,
}: {
    preview: ImportPreview;
    selection: ReadonlySet<string>;
    truncationApproved: boolean;
    selectedBytes: number;
    quotaBlocked: boolean;
    uploadErrorCode: string | null;
    onToggleConversation: (
        id: string,
        importable: boolean,
        needsTruncation: boolean
    ) => void;
    onTruncationApproval: (approved: boolean) => void;
    onStart: () => void;
    onCancel: () => void;
}) {
    const { t } = useLanguage();
    const totals = preview.totals;
    const selectedCount = preview.conversations.filter((row) =>
        selection.has(row.conversation.rawExternalConversationId)
    ).length;

    const warnings: string[] = [];
    if (totals.skippedNonConversationMessages > 0) {
        warnings.push(
            interpolate(t("externalImport.warningSkippedMessages"), {
                count: totals.skippedNonConversationMessages,
            })
        );
    }
    if (totals.skippedNonTextParts > 0) {
        warnings.push(
            interpolate(t("externalImport.warningSkippedParts"), {
                count: totals.skippedNonTextParts,
            })
        );
    }
    if (totals.additionalBranches > 0) {
        warnings.push(
            interpolate(t("externalImport.warningBranches"), {
                count: totals.additionalBranches,
            })
        );
    }

    return (
        <div data-testid="external-import-preview">
            <h2 className="text-sm font-bold">
                {t("externalImport.previewTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
                {interpolate(t("externalImport.previewProvider"), {
                    provider: providerLabel(preview.provider),
                })}
            </p>
            <p
                className="mt-1 text-sm leading-6 text-zinc-500"
                data-testid="external-import-preview-summary"
            >
                {interpolate(t("externalImport.previewSummary"), {
                    selected: selectedCount,
                    total: totals.conversations,
                    size: formatBytes(selectedBytes),
                })}
            </p>

            {warnings.length > 0 && (
                <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/60">
                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                        {t("externalImport.warningsTitle")}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs leading-5 text-zinc-500">
                        {warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                        ))}
                    </ul>
                </div>
            )}

            {totals.notImportable > 0 && (
                <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                    {interpolate(t("externalImport.notImportableExplain"), {
                        count: totals.notImportable,
                    })}
                </p>
            )}

            {totals.requiresTruncationApproval > 0 && (
                <div
                    className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20"
                    data-testid="external-import-truncation-approval"
                >
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                        {t("externalImport.truncationTitle")}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-amber-800/90 dark:text-amber-200/90">
                        {interpolate(t("externalImport.truncationExplain"), {
                            conversations: totals.requiresTruncationApproval,
                            limit: EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints.toLocaleString(),
                        })}
                    </p>
                    <label className="mt-2 flex items-start gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                        <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            checked={truncationApproved}
                            onChange={(event) =>
                                onTruncationApproval(event.target.checked)
                            }
                        />
                        {t("externalImport.truncationApprove")}
                    </label>
                </div>
            )}

            <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1">
                {preview.conversations.map((row) => {
                    const id = row.conversation.rawExternalConversationId;
                    const importable =
                        row.importability.kind !== "not_importable";
                    const needsTruncation =
                        row.importability.kind ===
                        "requires_truncation_approval";
                    const selectable =
                        importable && (!needsTruncation || truncationApproved);
                    const checked = selection.has(id);
                    return (
                        <li key={id}>
                            <label
                                className={`flex items-start gap-2.5 rounded-xl border px-3 py-2 ${
                                    selectable
                                        ? "cursor-pointer border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                                        : "cursor-not-allowed border-zinc-200 bg-zinc-50 opacity-60 dark:border-zinc-800 dark:bg-zinc-950/60"
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4"
                                    checked={checked}
                                    disabled={!selectable}
                                    data-testid="external-import-conversation-toggle"
                                    onChange={() =>
                                        onToggleConversation(
                                            id,
                                            importable,
                                            needsTruncation
                                        )
                                    }
                                />
                                <span className="min-w-0">
                                    <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                        {row.conversation.title}
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                                        {interpolate(
                                            t("externalImport.messagesCount"),
                                            {
                                                count: row.conversation
                                                    .messages.length,
                                            }
                                        )}
                                        {" · "}
                                        {formatBytes(row.estimatedStoredBytes)}
                                        {row.importability.kind ===
                                            "not_importable" && (
                                            <span className="ml-2 font-semibold text-amber-700 dark:text-amber-300">
                                                {t(
                                                    "externalImport.notImportableBadge"
                                                )}
                                            </span>
                                        )}
                                        {needsTruncation && (
                                            <span className="ml-2 font-semibold text-amber-700 dark:text-amber-300">
                                                {t(
                                                    "externalImport.truncatedBadge"
                                                )}
                                            </span>
                                        )}
                                    </span>
                                </span>
                            </label>
                        </li>
                    );
                })}
            </ul>

            {quotaBlocked && (
                <p
                    className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200"
                    data-testid="external-import-quota-warning"
                >
                    {t("externalImport.quotaExceededWarning")}
                </p>
            )}

            {uploadErrorCode !== null && (
                <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                    {uploadErrorCode === "EXTERNAL_IMPORT_QUOTA_EXCEEDED"
                        ? t("externalImport.finalizeFailedQuota")
                        : uploadErrorCode === "EXTERNAL_IMPORT_STAGING_EXPIRED"
                          ? t("externalImport.stagingExpired")
                          : t("externalImport.uploadFailed")}
                </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    className={primaryButtonClass}
                    data-testid="external-import-start"
                    disabled={selectedCount === 0 || quotaBlocked}
                    onClick={onStart}
                >
                    <Upload className="h-4 w-4" />
                    {uploadErrorCode !== null
                        ? t("externalImport.retryUpload")
                        : t("externalImport.startImport")}
                </button>
                <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={onCancel}
                >
                    {t("externalImport.cancel")}
                </button>
            </div>
        </div>
    );
}
