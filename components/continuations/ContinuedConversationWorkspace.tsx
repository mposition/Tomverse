"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, Lock, Send } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useWebSearchBackendReadiness } from "@/components/chat/WebSearchBackendReadinessProvider";
import { ContinuationModelSelector } from "@/components/continuations/ContinuationModelSelector";
import { interpolate, providerLabel } from "@/components/imports/importFormatting";
import { consumeChatStream } from "@/lib/chatStreamConsumer";
import {
    continuationTurns,
    messagesForModel,
} from "@/lib/continuationModelPanels";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { AiModel, ModelTier } from "@/lib/models";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
import { isWebSearchMode, type WebSearchMode } from "@/lib/appDefaults";

/**
 * A conversation continued from an imported chat, and the composer that
 * continues it.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.
 *
 * ## Why the two halves are two arrays
 *
 * The imported transcript and the Tomverse messages arrive from two endpoints
 * and are rendered as two sections with a divider between them. That is not a
 * styling choice: an `ExternalMessage` is somebody else's assistant answer,
 * kept immutable and deletable on its own terms, and a `Message` is an answer
 * this application produced and is accountable for. Merging them into one
 * array would make the difference a property of a CSS class, and the first
 * refactor that forgot it would show a ChatGPT answer as a Tomverse one.
 *
 * ## Why this is a separate screen from the Review workspace
 *
 * `/chat` and `/review` render the Review comparison workspace, which knows
 * nothing about imported transcripts. Teaching it would mean rewiring a
 * six-thousand-line client for a feature that is off by default, and the
 * repository's own rule is that Review's existing behaviour does not change
 * for this. `lib/continuationRoutes.ts` records where this lives and why.
 *
 * The product is the same either way: a continuation is `productKey =
 * "review"` (§3.1). What differs is the screen, not the product, which is why
 * the surface is decided by the bridge and never by the product key.
 *
 * ## Why there are several panels
 *
 * A continuation is a Review conversation
 * (docs/policy/external-conversation-continuation.md §3.1): one user turn is
 * answered by every selected model, each from the same imported excerpt. The
 * excerpt itself is rendered once, above the divider -- drawing it inside each
 * panel would put the same third-party transcript on screen N times and would
 * be one refactor away from looking like each model had produced it.
 *
 * The excerpt never travels through this component. Each request carries the
 * user's own messages and a model id; `/api/chat` builds the seed server-side,
 * per request, and prices it there (§5.1).
 *
 * ## Composer shape
 *
 * The textarea owns a dedicated full-width row and every control sits in its
 * own row beneath it -- no absolute positioning, no negative margins, no
 * shared grid cell (`docs/ui-contracts/mobile-chat-composer.md`). This screen
 * is not `ChatInput` and does not claim to be; it borrows the contract's shape
 * because the contract is about what a composer must not do to its own text
 * row, which is true wherever the row is.
 */

type TimelineMessage = {
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
};

type Timeline = {
    conversationId: string;
    provider: string;
    importedAt: string;
    seed: {
        messageCount: number;
        truncatedMessageCount: number;
        omittedMessageCount: number;
    };
    source:
        | {
              status: "available";
              title: string;
              messageTotal: number;
              offset: number;
              limit: number;
              messages: TimelineMessage[];
          }
        | { status: "deleted"; deletedAt: string | null }
        | { status: "locked" };
};

type ConversationMessage = {
    id: string;
    role: string;
    content: string;
    status?: string;
    modelId?: string | null;
    createdAt?: string;
};

type Conversation = {
    id: string;
    title: string;
    selectedModels: string[];
    webSearchMode?: string;
    messages: ConversationMessage[];
};

type LoadState =
    | { kind: "loading" }
    | { kind: "ready" }
    | { kind: "unauthenticated" }
    | { kind: "not_found" }
    | { kind: "locked" }
    | { kind: "error" };

const SOURCE_PAGE_SIZE = 100;

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

const newId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const formatDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
};

export function ContinuedConversationWorkspace({
    conversationId,
    maxModels,
    planTier,
}: {
    conversationId: string;
    /**
     * The plan's model cap, resolved on the server with the same
     * `effectivePlanModelLimit()` the PATCH route applies (§8.3). A prop, not
     * a client guess: a screen that invented the number would ask the owner to
     * choose a replacement they did not need, or send a change the server
     * refuses.
     */
    maxModels: number;
    planTier: ModelTier;
}) {
    const { t } = useLanguage();
    // `getModel` rather than the public list for naming and pricing: a
    // conversation can hold a model that is enabled but no longer publicly
    // listed, and a panel headed by a bare id -- priced at nothing -- is worse
    // than one headed by the model's real name. The picker still offers only
    // the publicly selectable set.
    const { getModel } = useModelCatalog();
    const backendReadiness = useWebSearchBackendReadiness();
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [timeline, setTimeline] = useState<Timeline | null>(null);
    const [conversation, setConversation] = useState<Conversation | null>(null);
    const [draft, setDraft] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const [loadingMoreSource, setLoadingMoreSource] = useState(false);
    const [savingModels, setSavingModels] = useState(false);
    const [modelError, setModelError] = useState<string | null>(null);
    /**
     * Per model, because one model failing is not the turn failing.
     *
     * §5.1: reservation, settlement and refund are per model request, and a
     * panel that could not answer must not take down a panel that did.
     */
    const [panelErrors, setPanelErrors] = useState<Record<string, string>>({});

    const loadAll = useCallback(async () => {
        try {
            const [conversationResponse, timelineResponse] = await Promise.all([
                fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
                    cache: "no-store",
                }),
                fetch(
                    `/api/conversations/${encodeURIComponent(conversationId)}/continuation?limit=${SOURCE_PAGE_SIZE}`,
                    { cache: "no-store" }
                ),
            ]);
            if (!conversationResponse.ok) {
                await discardResponseBody(conversationResponse);
                await discardResponseBody(timelineResponse);
                if (conversationResponse.status === 401) {
                    setState({ kind: "unauthenticated" });
                } else if (conversationResponse.status === 423) {
                    setState({ kind: "locked" });
                } else if (
                    conversationResponse.status === 403 ||
                    conversationResponse.status === 404
                ) {
                    setState({ kind: "not_found" });
                } else {
                    setState({ kind: "error" });
                }
                return;
            }
            const loaded = (await conversationResponse.json()) as Conversation;
            setConversation(loaded);
            if (timelineResponse.ok) {
                setTimeline((await timelineResponse.json()) as Timeline);
            } else {
                // A conversation with no bridge answers 404 here. That is not
                // an error for this screen to shout about -- it renders as an
                // ordinary conversation with no imported section.
                await discardResponseBody(timelineResponse);
                setTimeline(null);
            }
            setState({ kind: "ready" });
        } catch {
            setState({ kind: "error" });
        }
    }, [conversationId]);

    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            void loadAll().then(() => {
                if (cancelled) return;
            });
        });
        return () => {
            cancelled = true;
        };
    }, [loadAll]);

    const loadMoreSource = useCallback(async () => {
        if (!timeline || timeline.source.status !== "available") return;
        if (loadingMoreSource) return;
        const loaded = timeline.source.messages.length;
        if (loaded >= timeline.source.messageTotal) return;
        setLoadingMoreSource(true);
        try {
            const response = await fetch(
                `/api/conversations/${encodeURIComponent(conversationId)}/continuation?offset=${loaded}&limit=${SOURCE_PAGE_SIZE}`,
                { cache: "no-store" }
            );
            if (!response.ok) {
                await discardResponseBody(response);
                return;
            }
            const page = (await response.json()) as Timeline;
            if (page.source.status !== "available") {
                setTimeline(page);
                return;
            }
            const next = page.source;
            setTimeline((current) =>
                current && current.source.status === "available"
                    ? {
                          ...current,
                          source: {
                              ...next,
                              messages: [
                                  ...current.source.messages,
                                  ...next.messages,
                              ],
                          },
                      }
                    : page
            );
        } catch {
            // Leaving the already-loaded page on screen is the right failure:
            // the transcript is read-only and nothing is lost by not growing.
        } finally {
            setLoadingMoreSource(false);
        }
    }, [conversationId, loadingMoreSource, timeline]);

    /**
     * Saves a new model selection.
     *
     * Straight to `PATCH /api/conversations/[conversationId]` -- the same
     * endpoint the Review workspace uses, and the one that owns availability,
     * the plan's cap and the refusal (§8.3). Nothing about the selection is
     * decided here; the response is what the screen then shows.
     */
    const changeModels = useCallback(
        async (modelIds: string[]) => {
            if (savingModels || !conversation) return;
            setSavingModels(true);
            setModelError(null);
            try {
                const response = await fetch(
                    `/api/conversations/${encodeURIComponent(conversationId)}`,
                    {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ selectedModels: modelIds }),
                    }
                );
                if (!response.ok) {
                    const body = (await response
                        .json()
                        .catch(() => null)) as { code?: string } | null;
                    setModelError(
                        body?.code === "PLAN_MODEL_LIMIT_EXCEEDED"
                            ? interpolate(t("continuation.modelsPlanLimit"), {
                                  max: maxModels,
                              })
                            : t("continuation.modelsSaveFailed")
                    );
                    return;
                }
                const saved = (await response.json()) as {
                    selectedModels?: string[];
                };
                // The server's stored list, never the one just sent. A clamp
                // that dropped a delisted model has to be what the screen
                // shows, or the next turn is quoted for a model that will not
                // run.
                if (Array.isArray(saved.selectedModels)) {
                    setConversation((current) =>
                        current
                            ? { ...current, selectedModels: saved.selectedModels! }
                            : current
                    );
                }
            } catch {
                setModelError(t("continuation.modelsSaveFailed"));
            } finally {
                setSavingModels(false);
            }
        },
        [conversation, conversationId, maxModels, savingModels, t]
    );

    /**
     * One turn, one request per selected model.
     *
     * The order matters and each step is here for a reason §5.1 states:
     *
     *   1. the user's message is saved once, before any provider is asked
     *      anything, so a turn that fails still leaves what they wrote;
     *   2. a comparison of two or three models is admitted once, together --
     *      the concurrency policy is all-approved-or-all-rejected, and panels
     *      that each asked for their own slot would refuse each other;
     *   3. every request goes out with its own model id and its own history,
     *      and none of them carries the imported excerpt. The server rebuilds
     *      and prices that per request.
     */
    const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || isSending || !conversation) return;
        const modelIds = conversation.selectedModels.filter(
            (modelId) => modelId.length > 0
        );
        if (modelIds.length === 0) {
            setSendError(t("continuation.sendFailed"));
            return;
        }
        setIsSending(true);
        setSendError(null);
        setPanelErrors({});
        const userMessageId = newId();
        const assistantMessageIds = new Map(
            modelIds.map((modelId) => [modelId, newId()])
        );
        const priorMessages = conversation.messages;

        try {
            const saveResponse = await fetch(
                `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: [
                            {
                                id: userMessageId,
                                role: "user",
                                content: text,
                                status: "normal",
                            },
                        ],
                    }),
                }
            );
            if (!saveResponse.ok) {
                await discardResponseBody(saveResponse);
                setSendError(t("continuation.sendFailed"));
                return;
            }
            await discardResponseBody(saveResponse);

            setDraft("");
            setConversation((current) =>
                current
                    ? {
                          ...current,
                          messages: [
                              ...current.messages,
                              {
                                  id: userMessageId,
                                  role: "user",
                                  content: text,
                              },
                              ...modelIds.map((modelId) => ({
                                  id: assistantMessageIds.get(modelId)!,
                                  role: "assistant",
                                  content: "",
                                  modelId,
                              })),
                          ],
                      }
                    : current
            );

            // One admission for the whole comparison
            // (docs/policy/chat-concurrency-and-identity.md): all approved or
            // all refused. A single-model turn takes the ordinary path and
            // needs none -- `/api/chat/preflight` itself takes two or three.
            let admissionToken: string | null = null;
            let contextBundle: string | null = null;
            if (modelIds.length >= 2) {
                const preflight = await fetch("/api/chat/preflight", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        comparisonId: String(Date.now()),
                        conversationId,
                        modelIds,
                        prompt: text,
                        attachments: [],
                    }),
                });
                if (!preflight.ok) {
                    await discardResponseBody(preflight);
                    setSendError(t("continuation.sendFailed"));
                    return;
                }
                const grant = (await preflight.json().catch(() => null)) as {
                    admissionToken?: unknown;
                    contextBundle?: unknown;
                } | null;
                admissionToken =
                    typeof grant?.admissionToken === "string"
                        ? grant.admissionToken
                        : null;
                contextBundle =
                    typeof grant?.contextBundle === "string"
                        ? grant.contextBundle
                        : null;
            }

            const runModel = async (modelId: string) => {
                const assistantMessageId = assistantMessageIds.get(modelId)!;
                try {
                    const response = await fetch("/api/chat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            // This model's own branch of the conversation:
                            // every user turn, and only this model's answers.
                            // The imported excerpt is NOT in here -- it reaches
                            // the model as a server-built system block that the
                            // server itself priced, and a client that could put
                            // imported text in `messages` could put anything
                            // there (§5.1).
                            messages: [
                                ...messagesForModel(priorMessages, modelId).map(
                                    (message) => ({
                                        id: message.id,
                                        role: message.role,
                                        content: message.content,
                                        ...(message.modelId
                                            ? { modelId: message.modelId }
                                            : {}),
                                    })
                                ),
                                { id: userMessageId, role: "user", content: text },
                            ],
                            modelId,
                            conversationId,
                            assistantMessageId,
                            ...(admissionToken ? { admissionToken } : {}),
                            ...(contextBundle ? { contextBundle } : {}),
                        }),
                    });
                    if (!response.ok || !response.body) {
                        await discardResponseBody(response);
                        setPanelErrors((current) => ({
                            ...current,
                            [modelId]: t("continuation.sendFailed"),
                        }));
                        return;
                    }
                    // The same reader the chat workspace uses, so the
                    // out-of-band markers (keepalives, routing signals, the
                    // search trailer) are stripped here exactly as they are
                    // there rather than painted into the answer.
                    await consumeChatStream({
                        reader: response.body.getReader(),
                        liveness: {
                            noteKeepalive: () => {},
                            noteVisibleChunk: () => {},
                        },
                        onProgress: (progress) => {
                            setConversation((current) =>
                                current
                                    ? {
                                          ...current,
                                          messages: current.messages.map(
                                              (message) =>
                                                  message.id ===
                                                  assistantMessageId
                                                      ? {
                                                            ...message,
                                                            content:
                                                                progress.displayText,
                                                        }
                                                      : message
                                          ),
                                      }
                                    : current
                            );
                        },
                    });
                } catch {
                    setPanelErrors((current) => ({
                        ...current,
                        [modelId]: t("continuation.sendFailed"),
                    }));
                }
            };

            // In parallel, and each one's failure caught inside `runModel`, so
            // `allSettled` is not needed to keep one rejection from cancelling
            // the others -- and so a failed panel reports on itself rather than
            // through a banner that says the turn failed.
            await Promise.all(modelIds.map(runModel));
        } catch {
            setSendError(t("continuation.sendFailed"));
        } finally {
            setIsSending(false);
            // Re-read rather than trust what was painted: the server is what
            // decided each answer's final text, its status and its model.
            void loadAll();
        }
    }, [conversation, conversationId, draft, isSending, loadAll, t]);

    if (state.kind === "loading") {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
            </div>
        );
    }

    if (state.kind !== "ready" || !conversation) {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-8">
                <section className={sectionClass}>
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
                        <p className="text-sm leading-6 text-zinc-500">
                            {state.kind === "unauthenticated"
                                ? t("externalImport.signInRequired")
                                : state.kind === "locked"
                                  ? t("continuation.sourceLocked")
                                  : state.kind === "not_found"
                                    ? t("continuation.notFound")
                                    : t("externalImport.errorGeneric")}
                        </p>
                    </div>
                </section>
            </div>
        );
    }

    const source = timeline?.source;
    const selectedModels = conversation.selectedModels;
    const { turns, orphanedAnswers } = continuationTurns(
        conversation.messages,
        selectedModels
    );
    const modelName = (modelId: string) => getModel(modelId)?.name ?? modelId;

    /*
      What the next turn will cost, before it is sent (§4.4).

      The same estimator the chat composer uses, given the same inputs, so the
      two screens cannot quote differently for the same models. Per model and
      then summed -- never one model's figure multiplied by the count, because
      models differ in price and in what a web-search surcharge costs them.

      This is an estimate the *screen* shows. The reservation is the server's,
      taken per model request from the same system blocks `/api/chat/preflight`
      priced.
    */
    const selectedModelObjects = selectedModels
        .map((modelId) => getModel(modelId))
        .filter((model): model is AiModel => Boolean(model));
    const estimatedInputTokens = Math.max(
        1,
        Math.ceil(new TextEncoder().encode(draft).length / 4)
    );
    const conversationWebSearchMode: WebSearchMode = isWebSearchMode(
        conversation.webSearchMode
    )
        ? (conversation.webSearchMode as WebSearchMode)
        : "off";
    const creditEstimate = estimateRequestCredits({
        models: selectedModelObjects,
        estimatedInputTokens,
        webSearchMode: conversationWebSearchMode,
        backendReadiness,
    });

    return (
        <div
            className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8"
            data-testid="continued-conversation-workspace"
        >
            <div>
                <Link
                    href="/settings/imports"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                    data-testid="continuation-back"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    {t("continuation.backToImports")}
                </Link>
            </div>

            <section className={sectionClass}>
                <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                    {conversation.title}
                </h1>
                {timeline ? (
                    <>
                        <p
                            className="mt-1 text-sm leading-6 text-zinc-500"
                            data-testid="continuation-provenance"
                        >
                            {interpolate(t("continuation.sourceSectionSubtitle"), {
                                provider: providerLabel(timeline.provider),
                                date: formatDate(timeline.importedAt),
                            })}
                        </p>
                        <p
                            className="mt-0.5 text-xs leading-5 text-zinc-400"
                            data-testid="continuation-seed-summary"
                        >
                            {timeline.seed.messageCount === 0
                                ? t("continuation.seedNone")
                                : interpolate(t("continuation.seedSummary"), {
                                      used: timeline.seed.messageCount,
                                      total:
                                          source?.status === "available"
                                              ? source.messageTotal
                                              : timeline.seed.messageCount +
                                                timeline.seed.omittedMessageCount,
                                  })}
                            {timeline.seed.truncatedMessageCount > 0 ? (
                                <span className="ml-1">
                                    {interpolate(t("continuation.seedTruncated"), {
                                        count: timeline.seed.truncatedMessageCount,
                                    })}
                                </span>
                            ) : null}
                        </p>
                        <p className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                            {t("continuation.shareDisabled")}
                        </p>
                    </>
                ) : null}
            </section>

            {source ? (
                <section
                    className={sectionClass}
                    data-testid="continuation-source-section"
                >
                    <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-600 dark:text-zinc-300">
                        <Lock className="h-4 w-4" aria-hidden="true" />
                        {t("continuation.sourceSectionTitle")}
                    </h2>

                    {source.status === "deleted" ? (
                        <p
                            className="mt-2 text-sm leading-6 text-zinc-500"
                            data-testid="continuation-source-tombstone"
                        >
                            {t("continuation.sourceDeleted")}
                        </p>
                    ) : null}

                    {source.status === "locked" ? (
                        <p
                            className="mt-2 text-sm leading-6 text-zinc-500"
                            data-testid="continuation-source-locked"
                        >
                            {t("continuation.sourceLocked")}
                        </p>
                    ) : null}

                    {source.status === "available" ? (
                        <>
                            <ol className="mt-3 space-y-3">
                                {source.messages.map((message) => (
                                    <li
                                        key={message.id}
                                        className={`rounded-2xl border border-dashed p-3 ${
                                            message.role === "user"
                                                ? "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60"
                                                : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950/40"
                                        }`}
                                        data-testid="continuation-source-message"
                                    >
                                        <p className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-400">
                                            <span>
                                                {message.role === "user"
                                                    ? t("externalImport.viewerRoleUser")
                                                    : t(
                                                          "externalImport.viewerRoleAssistant"
                                                      )}
                                            </span>
                                            {message.role !== "user" ? (
                                                <span
                                                    className="rounded-md border border-zinc-300 px-1.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                                                    data-testid="continuation-external-badge"
                                                >
                                                    {providerLabel(timeline!.provider)}
                                                    {" · "}
                                                    {t(
                                                        "continuation.externalAnswerBadge"
                                                    )}
                                                </span>
                                            ) : null}
                                            {message.sourceModelLabel ? (
                                                <span className="font-mono text-[11px] normal-case tracking-normal text-zinc-400">
                                                    {message.sourceModelLabel}
                                                </span>
                                            ) : null}
                                        </p>
                                        {message.truncated ? (
                                            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                                                {t(
                                                    "externalImport.viewerTruncatedNotice"
                                                )}
                                            </p>
                                        ) : null}
                                        {/* Inert plain text, exactly as the
                                            read-only viewer renders it: a React
                                            text node cannot become markup. */}
                                        <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                                            {message.content}
                                        </p>
                                    </li>
                                ))}
                            </ol>
                            {source.messages.length < source.messageTotal ? (
                                <button
                                    type="button"
                                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                    data-testid="continuation-source-more"
                                    disabled={loadingMoreSource}
                                    onClick={() => void loadMoreSource()}
                                >
                                    {loadingMoreSource ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : null}
                                    {t("externalImport.loadMore")}
                                </button>
                            ) : null}
                        </>
                    ) : null}
                </section>
            ) : null}

            {timeline ? (
                <div
                    className="flex items-center gap-3"
                    data-testid="continuation-divider"
                >
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    <span className="text-xs font-bold text-zinc-500">
                        {t("continuation.divider")}
                    </span>
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                </div>
            ) : null}

            <ol className="space-y-4" data-testid="continuation-messages">
                {turns.map((turn) => (
                    <li key={turn.key} data-testid="continuation-turn">
                        {turn.user ? (
                            <div
                                className="rounded-2xl border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900/50 dark:bg-blue-950/20"
                                data-testid="continuation-message"
                            >
                                <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                                    {t("externalImport.viewerRoleUser")}
                                </p>
                                <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                                    {turn.user.content}
                                </p>
                            </div>
                        ) : null}
                        {/* One panel per selected model. The imported excerpt
                            is not repeated in any of them -- it is the single
                            section above the divider (§5.1). */}
                        <div
                            className={`mt-2 grid gap-3 ${
                                turn.answers.length > 1
                                    ? "sm:grid-cols-2 lg:grid-cols-3"
                                    : "grid-cols-1"
                            }`}
                        >
                            {turn.answers.map((answer) => (
                                <div
                                    key={answer.modelId}
                                    className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
                                    data-testid="continuation-model-panel"
                                    data-model-id={answer.modelId}
                                >
                                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                                        {modelName(answer.modelId)}
                                    </p>
                                    {answer.message ? (
                                        <p
                                            className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200"
                                            data-testid="continuation-message"
                                        >
                                            {answer.message.content}
                                        </p>
                                    ) : (
                                        // A model that has not answered this
                                        // turn: the panel stays so the columns
                                        // line up, but it carries no message.
                                        <p className="mt-2 text-sm leading-6 text-zinc-400">
                                            {t("continuation.modelNoAnswer")}
                                        </p>
                                    )}
                                    {panelErrors[answer.modelId] ? (
                                        <p
                                            className="mt-2 text-xs leading-5 text-red-600 dark:text-red-300"
                                            role="status"
                                            data-testid="continuation-panel-error"
                                        >
                                            {panelErrors[answer.modelId]}
                                        </p>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </li>
                ))}
            </ol>

            {orphanedAnswers.length > 0 ? (
                <p
                    className="text-xs leading-5 text-zinc-500"
                    data-testid="continuation-orphaned-answers"
                >
                    {interpolate(t("continuation.modelsRemovedAnswers"), {
                        count: orphanedAnswers.length,
                    })}
                </p>
            ) : null}

            {/*
              The composer. The textarea has a row to itself at full width and
              the controls have their own row underneath -- never beside it,
              never over it (docs/ui-contracts/mobile-chat-composer.md).
            */}
            <div className={sectionClass} data-testid="continuation-composer">
                <label className="sr-only" htmlFor="continuation-composer-input">
                    {t("continuation.composerPlaceholder")}
                </label>
                <div className="w-full">
                    <textarea
                        id="continuation-composer-input"
                        className="block max-h-48 min-h-[3rem] w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2 text-base leading-6 text-zinc-900 outline-none focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                        rows={2}
                        placeholder={t("continuation.composerPlaceholder")}
                        value={draft}
                        disabled={isSending}
                        onChange={(event) => setDraft(event.target.value)}
                        data-testid="continuation-composer-textarea"
                    />
                </div>
                <div className="mt-3 w-full">
                    <ContinuationModelSelector
                        selected={selectedModels}
                        maxModels={maxModels}
                        planTier={planTier}
                        saving={savingModels}
                        errorMessage={modelError}
                        onChange={(modelIds) => void changeModels(modelIds)}
                    />
                </div>
                <div className="mt-3 w-full">
                    <p
                        className="text-xs leading-5 text-zinc-500"
                        data-testid="continuation-credit-estimate"
                    >
                        {interpolate(t("continuation.creditEstimateTotal"), {
                            credits: creditEstimate.totalEstimatedCredits,
                            models: selectedModels.length,
                        })}
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                        {creditEstimate.models.map((entry) => (
                            <li
                                key={entry.modelId}
                                className="text-xs leading-5 text-zinc-400"
                                data-testid="continuation-credit-estimate-model"
                                data-model-id={entry.modelId}
                            >
                                {interpolate(
                                    t("continuation.creditEstimatePerModel"),
                                    {
                                        model: modelName(entry.modelId),
                                        credits: entry.totalCredits,
                                    }
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="mt-2 flex w-full flex-wrap items-center justify-end gap-2">
                    <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded-xl border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                        data-testid="continuation-send"
                        disabled={isSending || draft.trim().length === 0}
                        onClick={() => void send()}
                    >
                        {isSending ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                            <Send className="h-4 w-4" aria-hidden="true" />
                        )}
                        {isSending ? t("continuation.sending") : t("continuation.send")}
                    </button>
                </div>
                {sendError ? (
                    <p
                        className="mt-2 text-sm leading-6 text-red-600 dark:text-red-300"
                        role="status"
                        data-testid="continuation-send-error"
                    >
                        {sendError}
                    </p>
                ) : null}
            </div>
        </div>
    );
}
