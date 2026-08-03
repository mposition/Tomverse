"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

/**
 * /settings/imports/[importId] — read-only view of one import's outcome.
 *
 * Shows what the status endpoint reports to the owner: provider, dates,
 * counts and the stored conversation titles. Message content stays behind
 * the (future) viewer; deletion here removes the whole import and cascades
 * to its conversations and messages (policy §13.1).
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
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const providerLabel = (provider: string) =>
    provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : provider;

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
    conversations: Array<{
        id: string;
        title: string;
        messageCount: number;
        contentBytes: number;
        finalized: boolean;
        sourceUpdatedAt: string | null;
    }>;
};

type DetailState =
    | { kind: "loading" }
    | { kind: "ready"; detail: ImportDetail }
    | { kind: "unauthenticated" }
    | { kind: "disabled" }
    | { kind: "not_found" }
    | { kind: "error" };

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

export function ExternalImportDetail({ importId }: { importId: string }) {
    const { t } = useLanguage();
    const router = useRouter();
    const [state, setState] = useState<DetailState>({ kind: "loading" });
    const [deleteArmed, setDeleteArmed] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const response = await fetch(
                    `/api/imports/external/${encodeURIComponent(importId)}`,
                    { cache: "no-store" }
                );
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
                if (!response.ok) {
                    setState({ kind: "error" });
                    return;
                }
                const detail = (await response.json()) as ImportDetail;
                setState({ kind: "ready", detail });
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

            {state.kind === "ready" && (
                <>
                    <section
                        className={sectionClass}
                        data-testid="external-import-detail-summary"
                    >
                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {providerLabel(state.detail.provider)}
                            <span className="ml-2 text-xs font-medium text-zinc-500">
                                {new Date(
                                    state.detail.completedAt ??
                                        state.detail.createdAt
                                ).toLocaleDateString()}
                            </span>
                        </p>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {interpolate(
                                t("externalImport.historyConversations"),
                                { count: state.detail.counts.conversations }
                            )}
                            {" · "}
                            {interpolate(t("externalImport.messagesCount"), {
                                count: state.detail.counts.messages,
                            })}
                            {" · "}
                            {formatBytes(state.detail.counts.normalizedBytes)}
                        </p>
                        {state.detail.counts.truncatedMessages > 0 && (
                            <p className="mt-1 text-sm leading-6 text-zinc-500">
                                {interpolate(
                                    t("externalImport.stagedTruncated"),
                                    {
                                        count: state.detail.counts
                                            .truncatedMessages,
                                    }
                                )}
                            </p>
                        )}
                    </section>

                    <section className={sectionClass}>
                        <h2 className="text-sm font-bold">
                            {t("externalImport.detailConversations")}
                        </h2>
                        <ul className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                            {state.detail.conversations.map((conversation) => (
                                <li
                                    key={conversation.id}
                                    className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/60"
                                    data-testid="external-import-detail-conversation"
                                >
                                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                        {conversation.title}
                                    </p>
                                    <p className="mt-0.5 text-xs leading-5 text-zinc-500">
                                        {interpolate(
                                            t("externalImport.messagesCount"),
                                            {
                                                count: conversation.messageCount,
                                            }
                                        )}
                                        {" · "}
                                        {formatBytes(
                                            conversation.contentBytes
                                        )}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    </section>

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
                </>
            )}
        </div>
    );
}
