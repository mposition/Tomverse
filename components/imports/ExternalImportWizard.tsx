"use client";

import Link from "next/link";
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    interpolate,
    primaryButtonClass,
    secondaryButtonClass,
    sectionClass,
} from "@/components/imports/importFormatting";
import { ConversationSelectionStep } from "@/components/imports/wizard/ConversationSelectionStep";
import { FileInspectionStep } from "@/components/imports/wizard/FileInspectionStep";
import { ImportCompletedStep } from "@/components/imports/wizard/ImportCompletedStep";
import { ImportReviewStep } from "@/components/imports/wizard/ImportReviewStep";
import { ImportStepIndicator } from "@/components/imports/wizard/ImportStepIndicator";
import { ProviderGuideStep } from "@/components/imports/wizard/ProviderGuideStep";
import { EXTERNAL_IMPORT_PARSER_VERSION } from "@/lib/externalImportAdapters";
import type { ParsedExternalConversation } from "@/lib/externalImportAdapters/types";
import { buildBatchPayloads } from "@/lib/externalImportPipeline";
import { externalImportSelectionDigest } from "@/lib/externalImportSelectionDigest";
import {
    analyticsStepFor,
    canGoBack,
    classifyExternalImportFailure,
    externalImportWizardReducer,
    initialExternalImportWizardState,
    parseWarningTotalsFromPreview,
    selectionRowsFromPreview,
    wizardStepId,
    type CapacityRemaining,
    type StagedConversationSummary,
} from "@/lib/externalImportWizard";
import type { WorkerResponse } from "@/lib/workers/externalImportWorker";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

/**
 * /settings/imports/new — the full-screen import wizard.
 *
 * docs/policy/external-conversation-import-and-memory.md §5, §21.
 *
 * The state machine (lib/externalImportWizard.ts) decides *what* happens;
 * this component performs the effects and feeds the outcome back in. The
 * split matters because the interesting rules — truncation consent, the
 * difference between a network blip and a quota refusal, whether "select all"
 * means the rendered rows or the filtered dataset — are then testable without
 * a browser.
 *
 * Server contracts this component is responsible for keeping:
 *
 *   * the raw archive is opened by the Web Worker and never uploaded. Only
 *     the normalized text of the selected conversations is sent (§5.1);
 *   * batches go up strictly in sequence; a transport failure resends the
 *     same sequence with the same payload, so the ledger replays it (§5.5);
 *   * a quota refusal is never retried with the same payload. Either the
 *     selection is reduced inside the same import (nothing accepted yet), or
 *     the staging is deleted and a new import starts (§5.3);
 *   * finalize is explicit, all-or-nothing, and idempotent per subset.
 *
 * The wizard never pushes browser history for its internal steps: "Back" in
 * the page body moves between steps, and the browser's own Back leaves for
 * the management screen. There is no `beforeunload` trap.
 */

type CapacityState =
    | { kind: "loading" }
    | { kind: "ready"; remaining: CapacityRemaining }
    | { kind: "disabled" }
    | { kind: "unauthenticated" }
    | { kind: "error" };

const signatureOf = (
    selectedIds: ReadonlySet<string>,
    approvals: ReadonlySet<string>
) => `${[...selectedIds].sort().join(",")}|${[...approvals].sort().join(",")}`;

export function ExternalImportWizard() {
    const { t } = useLanguage();
    const [state, dispatch] = useReducer(
        externalImportWizardReducer,
        undefined,
        initialExternalImportWizardState
    );
    const [capacity, setCapacity] = useState<CapacityState>({ kind: "loading" });
    const [busy, setBusy] = useState(false);

    const workerRef = useRef<Worker | null>(null);
    const parsedRef = useRef<ParsedExternalConversation[]>([]);
    /**
     * Mirrors the parts of the reducer state the async upload loop needs.
     * The loop runs across awaits, so it cannot read `state` — but it must
     * not invent its own truth either, so everything it writes is dispatched
     * straight back into the reducer.
     */
    const uploadRef = useRef({
        importId: null as string | null,
        nextSequence: 0,
        staged: [] as StagedConversationSummary[],
        duplicates: 0,
        signature: "",
    });
    const finalizeKeyRef = useRef({ signature: "", key: "" });
    const stepRef = useRef<ReturnType<typeof analyticsStepFor>>(null);

    /* ----------------------------------------------------------------- */
    /* Capacity — also the feature-flag probe (403 => the wizard is shut) */
    /* ----------------------------------------------------------------- */
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch("/api/imports/external/capacity", {
                    cache: "no-store",
                });
                if (cancelled) return;
                if (response.status === 401) {
                    setCapacity({ kind: "unauthenticated" });
                    return;
                }
                if (response.status === 403) {
                    setCapacity({ kind: "disabled" });
                    return;
                }
                if (!response.ok) {
                    setCapacity({ kind: "error" });
                    return;
                }
                const body = (await response.json()) as {
                    remaining: CapacityRemaining;
                };
                setCapacity({ kind: "ready", remaining: body.remaining });
            } catch {
                if (!cancelled) setCapacity({ kind: "error" });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(
        () => () => {
            workerRef.current?.terminate();
            workerRef.current = null;
        },
        []
    );

    /* ----------------------------------------------------------------- */
    /* Step analytics (§22) — content-free, one closed enum property      */
    /* ----------------------------------------------------------------- */
    const currentAnalyticsStep = analyticsStepFor(state.status);
    useEffect(() => {
        if (!currentAnalyticsStep) return;
        if (stepRef.current === currentAnalyticsStep) return;
        stepRef.current = currentAnalyticsStep;
        trackProductEvent("external_import_step_entered", 0, {
            import_step: currentAnalyticsStep,
        });
    }, [currentAnalyticsStep]);

    useEffect(
        () => () => {
            // Fires on a deliberate exit only: a client-side route change or
            // an explicit reset unmounts this tree, a browser close does not.
            // That asymmetry is documented in §22 — `entered` counts are >=
            // `abandoned` counts and the two are not expected to reconcile.
            const step = stepRef.current;
            if (!step || step === "completed") return;
            trackProductEvent("external_import_step_abandoned", 0, {
                import_step: step,
            });
        },
        []
    );

    /* ----------------------------------------------------------------- */
    /* Worker parsing                                                     */
    /* ----------------------------------------------------------------- */
    const handleFileSelected = useCallback((file: File) => {
        workerRef.current?.terminate();
        const worker = new Worker(
            new URL("../../lib/workers/externalImportWorker.ts", import.meta.url),
            { type: "module" }
        );
        workerRef.current = worker;
        parsedRef.current = [];
        uploadRef.current = {
            importId: null,
            nextSequence: 0,
            staged: [],
            duplicates: 0,
            signature: "",
        };
        dispatch({ type: "file_accepted" });

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.type === "progress") {
                dispatch({
                    type: "parse_progress",
                    conversationsFound: message.conversationsFound,
                });
                return;
            }
            if (message.type === "preview") {
                parsedRef.current = message.conversations;
                dispatch({
                    type: "parse_succeeded",
                    provider: message.preview.provider,
                    rows: selectionRowsFromPreview(message.preview),
                    warnings: parseWarningTotalsFromPreview(message.preview),
                });
                trackProductEvent("external_import_parse_completed", 0, {
                    import_provider: message.preview.provider,
                });
                worker.terminate();
                workerRef.current = null;
                return;
            }
            if (message.type === "error") {
                if (message.reason === "out_of_memory") {
                    dispatch({ type: "device_limit_reached" });
                    trackProductEvent(
                        "external_import_desktop_recommended",
                        0,
                        { import_provider: "unknown" }
                    );
                } else {
                    dispatch({ type: "parse_failed", reason: message.reason });
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
            dispatch({ type: "parse_failed", reason: "worker_error" });
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
        workerRef.current?.terminate();
        workerRef.current = null;
        dispatch({ type: "back_to_guide" });
    }, []);

    /* ----------------------------------------------------------------- */
    /* Upload + seal                                                      */
    /* ----------------------------------------------------------------- */
    const discardStaging = useCallback(async (importId: string | null) => {
        if (!importId) return;
        try {
            await fetch(`/api/imports/external/${importId}`, {
                method: "DELETE",
            });
        } catch {
            // Abandoned staging is also cleared by the server TTL sweep.
        }
    }, []);

    const runPrepareReview = useCallback(async () => {
        const selected = parsedRef.current.filter((conversation) =>
            state.selectedIds.has(conversation.rawExternalConversationId)
        );
        if (selected.length === 0) return;
        const signature = signatureOf(
            state.selectedIds,
            state.truncationApprovals
        );

        // A selection edited after part of it was already accepted cannot be
        // appended to the same staging set: the server would end up holding
        // two different selections under one import. Discard and start over.
        if (
            uploadRef.current.importId &&
            uploadRef.current.signature !== signature
        ) {
            await discardStaging(uploadRef.current.importId);
            uploadRef.current = {
                importId: null,
                nextSequence: 0,
                staged: [],
                duplicates: 0,
                signature,
            };
            dispatch({ type: "restart_after_quota", importId: null });
        }
        uploadRef.current.signature = signature;

        let payloads;
        try {
            payloads = buildBatchPayloads(selected);
        } catch {
            dispatch({
                type: "prepare_review_failed",
                errorCode: "EXTERNAL_IMPORT_PAYLOAD_TOO_LARGE",
            });
            return;
        }

        setBusy(true);
        dispatch({
            type: "prepare_review_started",
            totalBatches: payloads.length,
        });

        try {
            if (!uploadRef.current.importId) {
                const created = await fetch("/api/imports/external", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        provider: state.detectedProvider,
                        parserVersion: EXTERNAL_IMPORT_PARSER_VERSION,
                    }),
                });
                if (!created.ok) {
                    const body = (await created.json().catch(() => null)) as {
                        code?: string;
                    } | null;
                    dispatch({
                        type: "prepare_review_failed",
                        errorCode: body?.code ?? null,
                    });
                    return;
                }
                const body = (await created.json()) as { importId: string };
                uploadRef.current.importId = body.importId;
            }
            const importId = uploadRef.current.importId;

            for (
                let sequence = uploadRef.current.nextSequence;
                sequence < payloads.length;
                sequence += 1
            ) {
                const response = await fetch(
                    `/api/imports/external/${importId}/batches`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payloads[sequence]),
                    }
                );
                if (!response.ok) {
                    const body = (await response.json().catch(() => null)) as {
                        code?: string;
                    } | null;
                    const failure = classifyExternalImportFailure(
                        body?.code ?? null
                    );
                    if (
                        failure === "quota" &&
                        uploadRef.current.nextSequence > 0
                    ) {
                        // Part of a now-abandoned selection is already staged:
                        // the only correct continuation is a brand-new import.
                        await discardStaging(importId);
                        uploadRef.current = {
                            importId: null,
                            nextSequence: 0,
                            staged: [],
                            duplicates: 0,
                            signature,
                        };
                    }
                    dispatch({
                        type: "prepare_review_failed",
                        errorCode: body?.code ?? null,
                    });
                    return;
                }
                const body = (await response.json()) as {
                    idempotentReplay: boolean;
                    results: Array<{
                        rawExternalConversationId: string;
                        outcome: "staged" | "duplicate";
                        stagedConversationId?: string;
                        conversationDigest: string;
                        truncatedMessageCount: number;
                    }>;
                };
                const staged: StagedConversationSummary[] = [];
                let duplicates = 0;
                for (const result of body.results) {
                    if (result.outcome === "staged" && result.stagedConversationId) {
                        const source = payloads[sequence].conversations.find(
                            (conversation) =>
                                conversation.rawExternalConversationId ===
                                result.rawExternalConversationId
                        );
                        staged.push({
                            stagedConversationId: result.stagedConversationId,
                            rawExternalConversationId:
                                result.rawExternalConversationId,
                            title: source?.title ?? "",
                            conversationDigest: result.conversationDigest,
                            messageCount: source?.messages.length ?? 0,
                            contentBytes: 0,
                            truncatedMessageCount:
                                result.truncatedMessageCount,
                        });
                    } else if (result.outcome === "duplicate") {
                        duplicates += 1;
                    }
                }
                uploadRef.current.nextSequence = sequence + 1;
                uploadRef.current.staged = [
                    ...uploadRef.current.staged,
                    ...staged,
                ];
                uploadRef.current.duplicates += duplicates;
                dispatch({
                    type: "batch_accepted",
                    importId: importId!,
                    sequence,
                    staged,
                    duplicatesSkipped: duplicates,
                });
            }

            // Seal: declare the upload complete and let the server check the
            // declaration against its own rows. Only a sealed import may be
            // resumed later, which is what stops a half-uploaded staging set
            // from ever being mistaken for a finished one.
            const sealResponse = await fetch(
                `/api/imports/external/${importId}/seal`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        finalSequence: payloads.length - 1,
                        expectedStagedConversationIds:
                            uploadRef.current.staged.map(
                                (row) => row.stagedConversationId
                            ),
                        expectedDuplicateCount: uploadRef.current.duplicates,
                    }),
                }
            );
            if (!sealResponse.ok) {
                const body = (await sealResponse.json().catch(() => null)) as {
                    code?: string;
                } | null;
                dispatch({
                    type: "prepare_review_failed",
                    errorCode: body?.code ?? null,
                });
                return;
            }
            const sealed = (await sealResponse.json()) as {
                sealedSelectionDigest: string;
                effectiveExpiresAt: string;
                duplicateCount: number;
                truncatedMessageCount: number;
                conversations: Array<{
                    id: string;
                    title: string;
                    conversationDigest: string;
                    messageCount: number;
                    contentBytes: number;
                }>;
            };
            const staged: StagedConversationSummary[] = sealed.conversations.map(
                (conversation) => ({
                    stagedConversationId: conversation.id,
                    rawExternalConversationId:
                        uploadRef.current.staged.find(
                            (row) => row.stagedConversationId === conversation.id
                        )?.rawExternalConversationId ?? "",
                    title: conversation.title,
                    conversationDigest: conversation.conversationDigest,
                    messageCount: conversation.messageCount,
                    contentBytes: conversation.contentBytes,
                    truncatedMessageCount:
                        uploadRef.current.staged.find(
                            (row) => row.stagedConversationId === conversation.id
                        )?.truncatedMessageCount ?? 0,
                })
            );
            dispatch({
                type: "review_ready",
                importId: importId!,
                staged,
                duplicatesSkipped: sealed.duplicateCount,
                truncatedMessages: sealed.truncatedMessageCount,
            });
            dispatch({
                type: "review_sealed",
                selectionDigest: sealed.sealedSelectionDigest,
                effectiveExpiresAt: sealed.effectiveExpiresAt,
            });
        } catch {
            dispatch({ type: "prepare_review_failed", errorCode: null });
        } finally {
            setBusy(false);
        }
    }, [
        discardStaging,
        state.detectedProvider,
        state.selectedIds,
        state.truncationApprovals,
    ]);

    /* ----------------------------------------------------------------- */
    /* Finalize                                                           */
    /* ----------------------------------------------------------------- */
    const runFinalize = useCallback(async () => {
        const review = state.review;
        if (!review) return;
        const selected = review.staged.filter((row) =>
            review.selectedStagedIds.has(row.stagedConversationId)
        );
        if (selected.length === 0) return;

        // The digest is recomputed for the subset actually being saved. Reusing
        // the sealed set's digest after narrowing the selection would make the
        // server reject a legitimate subset finalize.
        const subsetSignature = selected
            .map((row) => row.stagedConversationId)
            .sort()
            .join(",");
        if (finalizeKeyRef.current.signature !== subsetSignature) {
            finalizeKeyRef.current = {
                signature: subsetSignature,
                key: crypto.randomUUID(),
            };
        }

        dispatch({ type: "finalize_started" });
        try {
            const expectedImportDigest = await externalImportSelectionDigest(
                selected.map((row) => row.conversationDigest)
            );
            const response = await fetch(
                `/api/imports/external/${review.importId}/finalize`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        idempotencyKey: finalizeKeyRef.current.key,
                        selectedConversationIds: selected.map(
                            (row) => row.stagedConversationId
                        ),
                        expectedImportDigest,
                    }),
                }
            );
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                    code?: string;
                } | null;
                dispatch({
                    type: "finalize_failed",
                    errorCode: body?.code ?? null,
                });
                return;
            }
            const body = (await response.json()) as {
                finalizedConversations: number;
            };
            trackProductEvent("external_import_finalized", 0, {
                import_provider: state.detectedProvider ?? "unknown",
            });
            dispatch({
                type: "finalize_succeeded",
                finalizedConversations: body.finalizedConversations,
            });
        } catch {
            dispatch({ type: "finalize_failed", errorCode: null });
        }
    }, [state.review, state.detectedProvider]);

    const discardAndReset = useCallback(async () => {
        await discardStaging(
            state.review?.importId ?? uploadRef.current.importId
        );
        uploadRef.current = {
            importId: null,
            nextSequence: 0,
            staged: [],
            duplicates: 0,
            signature: "",
        };
        parsedRef.current = [];
        dispatch({ type: "reset" });
    }, [discardStaging, state.review?.importId]);

    const stepId = useMemo(() => wizardStepId(state.status), [state.status]);

    if (capacity.kind === "unauthenticated") {
        return (
            <WizardShell>
                <section className={sectionClass}>
                    <p className="text-sm leading-6 text-zinc-500">
                        {t("externalImport.signInRequired")}
                    </p>
                    <Link href="/auth/signin" className={`${primaryButtonClass} mt-4`}>
                        {t("auth.login")}
                    </Link>
                </section>
            </WizardShell>
        );
    }

    if (capacity.kind === "disabled") {
        return (
            <WizardShell>
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
            </WizardShell>
        );
    }

    return (
        <WizardShell>
            <div className={sectionClass}>
                <ImportStepIndicator currentStep={stepId} />
            </div>

            <section className={sectionClass} data-testid="external-import-wizard">
                {state.status.kind === "guide" && (
                    <ProviderGuideStep
                        guidanceProvider={state.guidanceProvider}
                        guidanceEntry={state.guidanceEntry}
                        onChooseProvider={(provider) =>
                            dispatch({
                                type: "choose_guidance_provider",
                                provider,
                            })
                        }
                        onChooseEntry={(entry) =>
                            dispatch({ type: "choose_guidance_entry", entry })
                        }
                        onContinue={() => dispatch({ type: "open_file_selection" })}
                    />
                )}

                {(state.status.kind === "file_selection" ||
                    state.status.kind === "parsing" ||
                    state.status.kind === "parse_failed" ||
                    state.status.kind === "desktop_recommended") && (
                    <FileInspectionStep
                        status={state.status}
                        onFileSelected={handleFileSelected}
                        onCancelParsing={cancelParsing}
                        onBack={() => dispatch({ type: "back_to_guide" })}
                        onRetry={() =>
                            dispatch({ type: "open_file_selection" })
                        }
                    />
                )}

                {(state.status.kind === "conversation_selection" ||
                    (state.status.kind === "quota_revision" &&
                        state.status.origin === "upload")) && (
                    <>
                        {state.status.kind === "quota_revision" && (
                            <QuotaRevisionNotice
                                origin={state.status.origin}
                                restart={
                                    state.status.plan.kind ===
                                    "restart_with_new_import"
                                }
                            />
                        )}
                        <ConversationSelectionStep
                            state={state}
                            capacityRemaining={
                                capacity.kind === "ready"
                                    ? capacity.remaining
                                    : null
                            }
                            busy={busy}
                            onToggleConversation={(id) =>
                                dispatch({ type: "toggle_conversation", id })
                            }
                            onSetTruncationApproval={(id, approved) =>
                                dispatch({
                                    type: "set_truncation_approval",
                                    id,
                                    approved,
                                })
                            }
                            onSelectAll={() =>
                                dispatch({ type: "select_all_matching_filter" })
                            }
                            onClearAll={() =>
                                dispatch({ type: "clear_all_matching_filter" })
                            }
                            onSetFilter={(filter) =>
                                dispatch({ type: "set_filter", filter })
                            }
                            onContinue={() => void runPrepareReview()}
                            onBack={() =>
                                dispatch({ type: "open_file_selection" })
                            }
                        />
                    </>
                )}

                {state.status.kind === "preparing_review" && (
                    <div data-testid="external-import-preparing-review">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t("externalImport.preparingReviewTitle")}
                        </div>
                        <p
                            className="mt-1 text-sm leading-6 text-zinc-500"
                            role="status"
                            aria-live="polite"
                        >
                            {interpolate(
                                t("externalImport.preparingReviewProgress"),
                                {
                                    sent: state.status.sentBatches,
                                    total: state.status.totalBatches,
                                }
                            )}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {t("externalImport.preparingReviewNotSaved")}
                        </p>
                    </div>
                )}

                {state.status.kind === "upload_failed" && (
                    <div data-testid="external-import-upload-failed">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                            <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                {state.status.failure === "transient"
                                    ? t("externalImport.uploadRetryTransient")
                                    : t("externalImport.uploadFailed")}
                            </p>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                            {state.status.failure === "transient" && (
                                <button
                                    type="button"
                                    className={primaryButtonClass}
                                    data-testid="external-import-retry-upload"
                                    onClick={() => void runPrepareReview()}
                                >
                                    <RefreshCw className="h-4 w-4" />
                                    {t("externalImport.retryUpload")}
                                </button>
                            )}
                            <button
                                type="button"
                                className={secondaryButtonClass}
                                data-testid="external-import-back-step"
                                onClick={() =>
                                    dispatch({ type: "back_to_selection" })
                                }
                            >
                                {t("externalImport.back")}
                            </button>
                        </div>
                    </div>
                )}

                {state.status.kind === "quota_revision" &&
                    state.status.origin === "finalize" && (
                        <QuotaRevisionNotice origin="finalize" restart={false} />
                    )}

                {(state.status.kind === "server_review" ||
                    state.status.kind === "finalizing" ||
                    (state.status.kind === "quota_revision" &&
                        state.status.origin === "finalize")) &&
                    state.review && (
                        <ImportReviewStep
                            review={state.review}
                            finalizing={state.status.kind === "finalizing"}
                            onToggleStaged={(stagedConversationId) =>
                                dispatch({
                                    type: "toggle_staged_conversation",
                                    stagedConversationId,
                                })
                            }
                            onFinalize={() => void runFinalize()}
                            onBackToSelection={() =>
                                dispatch({ type: "back_to_selection" })
                            }
                            onDiscard={() => void discardAndReset()}
                        />
                    )}

                {state.status.kind === "expired" && (
                    <div data-testid="external-import-expired">
                        <h2 className="text-base font-bold">
                            {t("externalImport.expiredTitle")}
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {t("externalImport.stagingExpired")}
                        </p>
                        <button
                            type="button"
                            className={`${secondaryButtonClass} mt-4`}
                            onClick={() => void discardAndReset()}
                        >
                            {t("externalImport.startAnother")}
                        </button>
                    </div>
                )}

                {state.status.kind === "completed" && (
                    <ImportCompletedStep
                        finalizedConversations={
                            state.status.finalizedConversations
                        }
                        onStartAnother={() => dispatch({ type: "reset" })}
                    />
                )}
            </section>

            {!canGoBack(state) && state.status.kind !== "completed" && (
                <p className="px-1 text-xs leading-5 text-zinc-400">
                    {t("externalImport.finalizingNotice")}
                </p>
            )}
        </WizardShell>
    );
}

function QuotaRevisionNotice({
    origin,
    restart,
}: {
    origin: "upload" | "finalize";
    restart: boolean;
}) {
    const { t } = useLanguage();
    return (
        <div
            className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/60 dark:bg-red-950/20"
            role="alert"
            data-testid="external-import-quota-revision"
        >
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">
                {t("externalImport.quotaRevisionTitle")}
            </p>
            <p className="mt-1 text-sm leading-6 text-red-800/90 dark:text-red-200/90">
                {origin === "finalize"
                    ? t("externalImport.finalizeFailedQuota")
                    : t("externalImport.quotaRevisionExplain")}
            </p>
            {restart && (
                <p
                    className="mt-1 text-sm leading-6 text-red-800/90 dark:text-red-200/90"
                    data-testid="external-import-quota-restart-notice"
                >
                    {t("externalImport.quotaRevisionRestartNotice")}
                </p>
            )}
        </div>
    );
}

function WizardShell({ children }: { children: React.ReactNode }) {
    const { t } = useLanguage();
    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
            <div>
                <Link
                    href="/settings/imports"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    data-testid="external-import-back"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("externalImport.backToImports")}
                </Link>
                <h1 className="mt-3 text-xl font-bold">
                    {t("externalImport.pageTitle")}
                </h1>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("externalImport.pageDescription")}
                </p>
            </div>
            {children}
        </div>
    );
}
