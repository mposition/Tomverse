"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    SourceDeletionNotice,
    type SourceDeletionImpactView,
} from "@/components/imports/SourceDeletionNotice";

/**
 * Account-private read-only viewer for one imported conversation (policy
 * §21). Message content renders as inert plain text — React text nodes with
 * pre-wrap, never HTML — which is the whole of the §19 XSS defence surface:
 * a `<script>` stored inside an imported message must appear on screen as
 * those nine characters.
 */

const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

const providerLabel = (provider: string) =>
    provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : provider;

type ViewerMessage = {
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
    originalCharacterCount: number | null;
    retainedCharacterCount: number | null;
};

type ViewerConversation = {
    id: string;
    provider: string;
    title: string;
    sourceModelLabels: string[];
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
    importedAt: string;
    messageTotal: number;
    messages: ViewerMessage[];
};

type ViewerState =
    | { kind: "loading" }
    | { kind: "ready"; conversation: ViewerConversation; loadingMore: boolean }
    | { kind: "unauthenticated" }
    | { kind: "disabled" }
    | { kind: "not_found" }
    | { kind: "error" };

const PAGE_SIZE = 100;

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

export function ExternalConversationViewer({
    conversationId,
}: {
    conversationId: string;
}) {
    const { t } = useLanguage();
    const router = useRouter();
    const [state, setState] = useState<ViewerState>({ kind: "loading" });
    const [deleteArmed, setDeleteArmed] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    // Requested with the first page only: the delete confirmation needs it,
    // paging through messages does not (§13.1).
    const [memoryImpact, setMemoryImpact] =
        useState<SourceDeletionImpactView | null>(null);
    const [keepMemories, setKeepMemories] = useState(false);

    const fetchPage = useCallback(
        async (offset: number): Promise<
            | { kind: "ok"; conversation: ViewerConversation }
            | { kind: "unauthenticated" }
            | { kind: "disabled" }
            | { kind: "not_found" }
            | { kind: "error" }
        > => {
            try {
                const response = await fetch(
                    `/api/external-conversations/${encodeURIComponent(conversationId)}?offset=${offset}&limit=${PAGE_SIZE}${offset === 0 ? "&include=memoryImpact" : ""}`,
                    { cache: "no-store" }
                );
                if (response.status === 401) return { kind: "unauthenticated" };
                if (response.status === 403) return { kind: "disabled" };
                if (response.status === 404) return { kind: "not_found" };
                if (!response.ok) return { kind: "error" };
                const conversation = (await response.json()) as ViewerConversation & {
                    memoryImpact?: SourceDeletionImpactView;
                };
                if (offset === 0 && conversation.memoryImpact) {
                    setMemoryImpact(conversation.memoryImpact);
                }
                return { kind: "ok", conversation };
            } catch {
                return { kind: "error" };
            }
        },
        [conversationId]
    );

    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            void fetchPage(0).then((result) => {
                if (cancelled) return;
                if (result.kind === "ok") {
                    setState({
                        kind: "ready",
                        conversation: result.conversation,
                        loadingMore: false,
                    });
                } else {
                    setState({ kind: result.kind });
                }
            });
        });
        return () => {
            cancelled = true;
        };
    }, [fetchPage]);

    const loadMore = useCallback(async () => {
        if (state.kind !== "ready" || state.loadingMore) return;
        const loaded = state.conversation.messages.length;
        if (loaded >= state.conversation.messageTotal) return;
        setState({ ...state, loadingMore: true });
        const result = await fetchPage(loaded);
        if (result.kind === "ok") {
            setState({
                kind: "ready",
                conversation: {
                    ...result.conversation,
                    messages: [
                        ...state.conversation.messages,
                        ...result.conversation.messages,
                    ],
                },
                loadingMore: false,
            });
        } else {
            setState({ ...state, loadingMore: false });
        }
    }, [fetchPage, state]);

    const deleteSnapshot = useCallback(async () => {
        if (!deleteArmed) {
            setDeleteArmed(true);
            return;
        }
        setIsDeleting(true);
        try {
            const response = await fetch(
                `/api/external-conversations/${encodeURIComponent(conversationId)}?derivedMemories=${
                    keepMemories ? "suspend" : "delete"
                }`,
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
    }, [conversationId, deleteArmed, keepMemories, router]);

    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
            <div>
                <Link
                    href="/settings/imports"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    data-testid="external-viewer-back"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("externalImport.backToImports")}
                </Link>
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
                <div data-testid="external-conversation-viewer">
                    <section className={sectionClass}>
                        <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                            {state.conversation.title}
                        </h1>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {providerLabel(state.conversation.provider)}
                            {state.conversation.sourceModelLabels.length >
                                0 && (
                                <span className="ml-2">
                                    {interpolate(
                                        t("externalImport.viewerSourceModel"),
                                        {
                                            label: state.conversation.sourceModelLabels.join(
                                                ", "
                                            ),
                                        }
                                    )}
                                </span>
                            )}
                        </p>
                        <p className="mt-0.5 text-xs leading-5 text-zinc-400">
                            {interpolate(
                                t("externalImport.viewerMessagesShown"),
                                {
                                    shown: state.conversation.messages.length,
                                    total: state.conversation.messageTotal,
                                }
                            )}
                        </p>
                    </section>

                    <ol className="mt-4 space-y-3">
                        {state.conversation.messages.map((message) => (
                            <li
                                key={message.id}
                                className={`rounded-2xl border p-4 ${
                                    message.role === "user"
                                        ? "border-blue-200 bg-blue-50/60 dark:border-blue-900/50 dark:bg-blue-950/20"
                                        : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/60"
                                }`}
                                data-testid="external-viewer-message"
                            >
                                <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                                    {message.role === "user"
                                        ? t("externalImport.viewerRoleUser")
                                        : t(
                                              "externalImport.viewerRoleAssistant"
                                          )}
                                    {message.sourceModelLabel && (
                                        <span className="ml-2 font-mono normal-case tracking-normal">
                                            {message.sourceModelLabel}
                                        </span>
                                    )}
                                </p>
                                {message.truncated && (
                                    <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                                        {t(
                                            "externalImport.viewerTruncatedNotice"
                                        )}
                                    </p>
                                )}
                                {/* Inert plain text on purpose (§4, §19):
                                    a React text node cannot become markup. */}
                                <p className="mt-2 text-sm leading-6 text-zinc-800 whitespace-pre-wrap break-words dark:text-zinc-200">
                                    {message.content}
                                </p>
                            </li>
                        ))}
                    </ol>

                    {state.conversation.messages.length <
                        state.conversation.messageTotal && (
                        <button
                            type="button"
                            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            data-testid="external-viewer-more"
                            disabled={state.loadingMore}
                            onClick={() => void loadMore()}
                        >
                            {state.loadingMore ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : null}
                            {t("externalImport.loadMore")}
                        </button>
                    )}

                    <section className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-950/70 dark:bg-red-950/20">
                        <p className="text-sm leading-6 text-red-700/90 dark:text-red-200/90">
                            {t("externalImport.deleteNote")}
                        </p>
                        <button
                            type="button"
                            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                            data-testid="external-viewer-delete"
                            disabled={isDeleting}
                            onClick={() => void deleteSnapshot()}
                        >
                            <Trash2 className="h-4 w-4" />
                            {isDeleting
                                ? t("externalImport.deleting")
                                : deleteArmed
                                  ? t("externalImport.deleteImportArmed")
                                  : t("externalImport.deleteSnapshot")}
                        </button>
                        {deleteArmed ? (
                            <SourceDeletionNotice
                                impact={memoryImpact}
                                scope="conversation"
                                keepDerived={keepMemories}
                                onKeepDerivedChange={setKeepMemories}
                            />
                        ) : null}
                    </section>
                </div>
            )}
        </div>
    );
}
