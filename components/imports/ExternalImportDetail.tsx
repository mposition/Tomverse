"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, Loader2, Trash2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    formatBytes,
    interpolate,
    primaryButtonClass,
    providerLabel,
    secondaryButtonClass,
    sectionClass,
} from "@/components/imports/importFormatting";
import { ImportReviewStep } from "@/components/imports/wizard/ImportReviewStep";
import { externalImportSelectionDigest } from "@/lib/externalImportSelectionDigest";
import {
    classifyExternalImportFailure,
    type ServerReview,
} from "@/lib/externalImportWizard";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * /settings/imports/[importId] — one import's outcome, or the place a sealed
 * one is finished.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.5, §13.1.
 *
 * A completed import shows what was stored. An unfinished one is where the
 * seal contract pays off, because the three unfinished shapes need three
 * different screens:
 *
 *   * `preview_ready` inside its TTL — the upload was declared complete and
 *     verified against the server's own rows, so the staged set can be shown
 *     and confirmed here. Seal fixed completeness, not selection: the user
 *     may still drop conversations, and the import digest is recomputed for
 *     whatever subset is actually saved;
 *   * `staging` — a partial upload nobody sealed. The server cannot know
 *     whether the rest was ever coming, so this offers start-over and delete
 *     and no confirmation CTA. The parsed payload lives only in the tab that
 *     produced it, and is deliberately not persisted anywhere to fake a
 *     resume (§5.1);
 *   * expired — shown as expired, never quietly hidden.
 *
 * Deletion removes the whole import and cascades to its conversations and
 * messages; on an unfinished one it is the staging cancel (§5.5).
 */

type DetailConversation = {
    id: string;
    title: string;
    conversationDigest: string;
    messageCount: number;
    contentBytes: number;
    truncatedMessageCount: number;
    finalized: boolean;
    sourceUpdatedAt: string | null;
};

type ImportDetail = {
    id: string;
    provider: string;
    status: string;
    counts: {
        conversations: number;
        messages: number;
        normalizedBytes: number;
        truncatedMessages: number;
        duplicatesSkipped: number;
    };
    createdAt: string;
    completedAt: string | null;
    effectiveExpiresAt?: string | null;
    expired?: boolean;
    conversations: DetailConversation[];
};

type DetailState =
    | { kind: "loading" }
    | { kind: "ready"; detail: ImportDetail }
    | { kind: "unauthenticated" }
    | { kind: "disabled" }
    | { kind: "not_found" }
    | { kind: "error" };

/** Mirrors the wizard's finalize outcome so the same review UI can drive it. */
type FinalizeState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "quota_revision" }
    | { kind: "expired" }
    | { kind: "failed" }
    | { kind: "done"; finalizedConversations: number };

export function ExternalImportDetail({ importId }: { importId: string }) {
    const { t } = useLanguage();
    const router = useRouter();
    const [state, setState] = useState<DetailState>({ kind: "loading" });
    const [deleteArmed, setDeleteArmed] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [review, setReview] = useState<ServerReview | null>(null);
    const [finalizeState, setFinalizeState] = useState<FinalizeState>({
        kind: "idle",
    });
    // One key per subset. Reusing a key across a changed subset would be a
    // digest conflict; minting a fresh one per attempt would turn a retry
    // into a second import (§5.5 finalize idempotency).
    const finalizeKeyRef = useRef({ signature: "", key: "" });

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const response = await fetch(
                    `/api/imports/external/${encodeURIComponent(importId)}`,
                    { cache: "no-store" }
                );
                if (cancelled || !response.ok) {
                    // None of these branches parses the body, so it is
                    // consumed once here rather than in five places.
                    await discardResponseBody(response);
                    if (cancelled) return;
                    if (response.status === 401) {
                        setState({ kind: "unauthenticated" });
                        return;
                    }
                    if (response.status === 403) {
                        setState({ kind: "disabled" });
                        return;
                    }
                    if (response.status === 404) {
                        setState({ kind: "not_found" });
                        return;
                    }
                    setState({ kind: "error" });
                    return;
                }
                const detail = (await response.json()) as ImportDetail;
                if (cancelled) return;
                setState({ kind: "ready", detail });
                if (detail.status === "preview_ready" && !detail.expired) {
                    const staged = detail.conversations.filter(
                        (conversation) => !conversation.finalized
                    );
                    setReview({
                        importId: detail.id,
                        staged: staged.map((conversation) => ({
                            stagedConversationId: conversation.id,
                            // The raw provider id never leaves the browser that
                            // parsed the archive, and the resume screen has no
                            // use for it.
                            rawExternalConversationId: "",
                            title: conversation.title,
                            conversationDigest: conversation.conversationDigest,
                            messageCount: conversation.messageCount,
                            contentBytes: conversation.contentBytes,
                            truncatedMessageCount:
                                conversation.truncatedMessageCount,
                        })),
                        duplicatesSkipped: detail.counts.duplicatesSkipped,
                        truncatedMessages: detail.counts.truncatedMessages,
                        selectedStagedIds: new Set(
                            staged.map((conversation) => conversation.id)
                        ),
                        // Reaching preview_ready is what sealing means.
                        sealed: true,
                        sealedSelectionDigest: null,
                        effectiveExpiresAt: detail.effectiveExpiresAt ?? null,
                    });
                }
            } catch {
                if (!cancelled) setState({ kind: "error" });
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [importId]);

    const deleteImport = useCallback(async () => {
        if (!deleteArmed) {
            setDeleteArmed(true);
            return;
        }
        setIsDeleting(true);
        try {
            const response = await fetch(
                `/api/imports/external/${encodeURIComponent(importId)}`,
                { method: "DELETE" }
            );
            await discardResponseBody(response);
            if (response.ok) {
                router.push("/settings/imports");
                return;
            }
            setState({ kind: "error" });
        } catch {
            setState({ kind: "error" });
        } finally {
            setIsDeleting(false);
            setDeleteArmed(false);
        }
    }, [deleteArmed, importId, router]);

    const toggleStaged = useCallback((stagedConversationId: string) => {
        setReview((current) => {
            if (!current) return current;
            const next = new Set(current.selectedStagedIds);
            if (next.has(stagedConversationId)) next.delete(stagedConversationId);
            else next.add(stagedConversationId);
            return { ...current, selectedStagedIds: next };
        });
    }, []);

    const runFinalize = useCallback(async () => {
        if (!review) return;
        const selected = review.staged.filter((conversation) =>
            review.selectedStagedIds.has(conversation.stagedConversationId)
        );
        if (selected.length === 0) return;

        const signature = selected
            .map((conversation) => conversation.stagedConversationId)
            .sort()
            .join(",");
        if (finalizeKeyRef.current.signature !== signature) {
            finalizeKeyRef.current = {
                signature,
                key: crypto.randomUUID(),
            };
        }

        setFinalizeState({ kind: "running" });
        try {
            // Recomputed for the subset actually being saved, never replayed
            // from the sealed set's digest.
            const expectedImportDigest = await externalImportSelectionDigest(
                selected.map((conversation) => conversation.conversationDigest)
            );
            const response = await fetch(
                `/api/imports/external/${encodeURIComponent(review.importId)}/finalize`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        idempotencyKey: finalizeKeyRef.current.key,
                        selectedConversationIds: selected.map(
                            (conversation) => conversation.stagedConversationId
                        ),
                        expectedImportDigest,
                    }),
                }
            );
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                    code?: string;
                } | null;
                const failure = classifyExternalImportFailure(body?.code ?? null);
                setFinalizeState({
                    kind:
                        failure === "quota"
                            ? "quota_revision"
                            : failure === "expired"
                              ? "expired"
                              : "failed",
                });
                return;
            }
            const body = (await response.json()) as {
                finalizedConversations: number;
            };
            setFinalizeState({
                kind: "done",
                finalizedConversations: body.finalizedConversations,
            });
        } catch {
            setFinalizeState({ kind: "failed" });
        }
    }, [review]);

    const detail = state.kind === "ready" ? state.detail : null;
    const unfinished =
        detail?.status === "staging" || detail?.status === "preview_ready";
    const expired = unfinished && detail?.expired === true;
    const resumable =
        detail?.status === "preview_ready" && !expired && review !== null;

    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
            <div>
                <Link
                    href="/settings/imports"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    data-testid="external-import-detail-back"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("externalImport.backToImports")}
                </Link>
                <h1 className="mt-3 text-xl font-bold">
                    {t("externalImport.detailTitle")}
                </h1>
            </div>

            {state.kind === "loading" && (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                </div>
            )}

            {state.kind === "unauthenticated" && (
                <section className={sectionClass}>
                    <p className="text-sm leading-6 text-zinc-500">
                        {t("externalImport.signInRequired")}
                    </p>
                </section>
            )}

            {state.kind === "disabled" && (
                <section className={sectionClass}>
                    <p className="text-sm leading-6 text-zinc-500">
                        {t("externalImport.disabledNotice")}
                    </p>
                </section>
            )}

            {(state.kind === "not_found" || state.kind === "error") && (
                <section className={sectionClass}>
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
                        <p className="text-sm leading-6 text-zinc-500">
                            {state.kind === "not_found"
                                ? t("externalImport.detailNotFound")
                                : t("externalImport.errorGeneric")}
                        </p>
                    </div>
                </section>
            )}

            {detail && (
                <>
                    <section
                        className={sectionClass}
                        data-testid="external-import-detail-summary"
                    >
                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {providerLabel(detail.provider)}
                            <span className="ml-2 text-xs font-medium text-zinc-500">
                                {new Date(
                                    detail.completedAt ?? detail.createdAt
                                ).toLocaleDateString()}
                            </span>
                        </p>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {interpolate(
                                t("externalImport.historyConversations"),
                                { count: detail.counts.conversations }
                            )}
                            {" · "}
                            {interpolate(t("externalImport.messagesCount"), {
                                count: detail.counts.messages,
                            })}
                            {" · "}
                            {formatBytes(detail.counts.normalizedBytes)}
                        </p>
                        {detail.counts.truncatedMessages > 0 && (
                            <p className="mt-1 text-sm leading-6 text-zinc-500">
                                {interpolate(
                                    t("externalImport.stagedTruncated"),
                                    { count: detail.counts.truncatedMessages }
                                )}
                            </p>
                        )}
                    </section>

                    {finalizeState.kind === "done" ? (
                        <section
                            className={sectionClass}
                            data-testid="external-import-detail-completed"
                        >
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-success-500" />
                                <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                    {interpolate(
                                        t("externalImport.importCompleted"),
                                        {
                                            count: finalizeState.finalizedConversations,
                                        }
                                    )}
                                </p>
                            </div>
                            <Link
                                href="/settings/imports"
                                className={`${primaryButtonClass} mt-4`}
                            >
                                {t("externalImport.backToImports")}
                            </Link>
                        </section>
                    ) : expired ? (
                        <section
                            className={sectionClass}
                            data-testid="external-import-detail-expired"
                        >
                            <div className="flex items-start gap-3">
                                <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                                <div>
                                    <h2 className="text-base font-bold">
                                        {t("externalImport.expiredTitle")}
                                    </h2>
                                    <p className="mt-1 text-sm leading-6 text-zinc-500">
                                        {t("externalImport.expiredCardNotice")}
                                    </p>
                                </div>
                            </div>
                            <Link
                                href="/settings/imports/new"
                                className={`${secondaryButtonClass} mt-4`}
                                data-testid="external-import-detail-restart"
                            >
                                {t("externalImport.inProgressRestart")}
                            </Link>
                        </section>
                    ) : resumable ? (
                        <section
                            className={sectionClass}
                            data-testid="external-import-detail-resume"
                        >
                            {finalizeState.kind === "quota_revision" && (
                                <div
                                    className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/60 dark:bg-red-950/20"
                                    role="alert"
                                    data-testid="external-import-detail-quota"
                                >
                                    <p className="text-sm font-semibold text-red-800 dark:text-red-200">
                                        {t("externalImport.quotaRevisionTitle")}
                                    </p>
                                    <p className="mt-1 text-sm leading-6 text-red-800/90 dark:text-red-200/90">
                                        {t(
                                            "externalImport.finalizeFailedQuota"
                                        )}
                                    </p>
                                </div>
                            )}
                            {finalizeState.kind === "failed" && (
                                <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
                                    {t("externalImport.errorGeneric")}
                                </p>
                            )}
                            {finalizeState.kind === "expired" && (
                                <p
                                    className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
                                    data-testid="external-import-detail-expired-late"
                                >
                                    {t("externalImport.stagingExpired")}
                                </p>
                            )}
                            <ImportReviewStep
                                review={review}
                                finalizing={finalizeState.kind === "running"}
                                onToggleStaged={toggleStaged}
                                onFinalize={() => void runFinalize()}
                                onBackToSelection={() =>
                                    router.push("/settings/imports")
                                }
                                onDiscard={() => void deleteImport()}
                            />
                        </section>
                    ) : unfinished ? (
                        <section
                            className={sectionClass}
                            data-testid="external-import-detail-not-resumable"
                        >
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                                <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                    {t(
                                        "externalImport.inProgressNotResumable"
                                    )}
                                </p>
                            </div>
                            <Link
                                href="/settings/imports/new"
                                className={`${secondaryButtonClass} mt-4`}
                                data-testid="external-import-detail-restart"
                            >
                                {t("externalImport.inProgressRestart")}
                            </Link>
                        </section>
                    ) : (
                        <section className={sectionClass}>
                            <h2 className="text-sm font-bold">
                                {t("externalImport.detailConversations")}
                            </h2>
                            <ul className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                                {detail.conversations.map((conversation) => (
                                    <li
                                        key={conversation.id}
                                        data-testid="external-import-detail-conversation"
                                    >
                                        <Link
                                            href={`/settings/imports/conversations/${conversation.id}`}
                                            className="block rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:bg-zinc-900"
                                        >
                                            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                                {conversation.title}
                                            </p>
                                            <p className="mt-0.5 text-xs leading-5 text-zinc-500">
                                                {interpolate(
                                                    t(
                                                        "externalImport.messagesCount"
                                                    ),
                                                    {
                                                        count: conversation.messageCount,
                                                    }
                                                )}
                                                {" · "}
                                                {formatBytes(
                                                    conversation.contentBytes
                                                )}
                                            </p>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {finalizeState.kind !== "done" && (
                        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-950/70 dark:bg-red-950/20">
                            <p className="text-sm leading-6 text-red-700/90 dark:text-red-200/90">
                                {t("externalImport.deleteNote")}
                            </p>
                            <button
                                type="button"
                                className="mt-3 inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                                data-testid="external-import-detail-delete"
                                disabled={isDeleting}
                                onClick={() => void deleteImport()}
                            >
                                <Trash2 className="h-4 w-4" />
                                {isDeleting
                                    ? t("externalImport.deleting")
                                    : deleteArmed
                                      ? t("externalImport.deleteImportArmed")
                                      : t("externalImport.deleteImport")}
                            </button>
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
