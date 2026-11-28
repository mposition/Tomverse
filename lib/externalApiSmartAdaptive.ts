import "server-only";
import { createHash } from "node:crypto";
import { assertOperationalFeatureEnabled } from "@/lib/appSettings";
import { pickAutoModelWithLlm } from "@/lib/autoLlmRouter";
import type { CodingRouterContext } from "@/lib/autoLlmRouterCore";
import { keyCreditTotals } from "@/lib/externalApiAdmission";
import { withCandidateModels, type externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { isSmartAdaptiveOnlyModel, smartAdaptiveRouterEnabled } from "@/lib/externalApiCatalogCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import {
    chatText,
    conversationModelMayMove,
    estimatedChatInputTokens,
    escalateOnly,
    smartAdaptiveCodingContext,
    smartAdaptiveConversationKey,
} from "@/lib/externalApiSmartAdaptiveCore";
import { modelTakesRequestFeatures, type ChatCompletionRequest } from "@/lib/openAiChatProtocol";
import { prisma } from "@/lib/prisma";

type RunnableEntry = Awaited<ReturnType<typeof externalApiRunnableModels>>[number];

/**
 * Smart Adaptive for the external API: Chat's own LLM router picks which
 * catalogue model answers a request. See docs/policy/external-api.md.
 *
 * Candidates are the runnable models that fit this request: images only to a
 * model that reads them, input plus requested output within the model's
 * window, and the optional features the request uses (strict tools, image
 * detail, reasoning effort) by the same rules the request is validated with.
 *
 * The router call is paid (the provider operational budget), and it runs
 * before admission, because admission reserves for the model it picks. So it
 * is made only when admission is not already known to refuse: not while AI
 * chat is paused, not when the key's cap is spent, and not for a key whose
 * Smart Adaptive request was refused at admission in the last two minutes
 * (credits, allowance, concurrency). Otherwise the default model is taken and
 * admission refuses with its own error. An Idempotency-Key replay is answered
 * before this runs, and a concurrent duplicate of one still routing waits for
 * that call and takes the same model. The gate's checks run only when a
 * router call is next.
 * Without the router switch, or when the router gives no answer, the default
 * model answers if it fits, otherwise the first candidate that is not frontier
 * or apex: those are only ever the router's pick. With no such model runnable
 * there is no Smart Adaptive here (routeSmartAdaptive answers null): the
 * request is refused as a model this key does not have, before any router
 * call, reservation or dispatch.
 *
 * A coding client sends every tool round as a new request, so routing each one
 * afresh would let the model change half-way through a task. A request that
 * carries tool results back therefore goes to the model that made those tool
 * calls: when a Smart Adaptive answer ends with tool calls, its model is
 * remembered in this process under the key and each tool-call id, and the
 * round that answers them is looked up by the ids it carries. A tool-call id
 * belongs to one answer, so concurrent requests with the same history, refused
 * requests and requests that never produced a call cannot overwrite each
 * other. Only ids and model ids are kept; a miss (another instance, a
 * restart, ten minutes later) simply routes again.
 *
 * A new user message is routed with the coding guidance and what the request
 * shows of the task (lib/autoLlmRouterCore.ts, CodingRouterContext), and the
 * model already working on the conversation. Within a conversation the model
 * only moves up: a pick with fewer credits than that model keeps that model,
 * because a switch mid-task loses its cache and reasoning, while a task that
 * needs more can still move to a stronger one. The conversation is known by
 * the opening of its history (everything before the first assistant message);
 * its model is remembered in this process once admission accepted a request
 * on it, so a pick the account cannot pay for is never held. A miss (another
 * instance, a restart, six hours later, a client that rewrites the opening)
 * routes freely, as before.
 *
 * Every decision is logged as `external_api_smart_adaptive_routed`: ids,
 * counts and the model, never the request's text.
 */

const STICKY_MS = 10 * 60_000;
const STICKY_MAX = 2_000;
const sticky = new Map<string, { modelId: string; at: number }>();
const callKey = (keyId: string, toolCallId: string) => `${keyId}\0${toolCallId}`;

/** Called when a Smart Adaptive answer ended with these tool calls. */
export const rememberSmartAdaptiveToolCalls = (
    keyId: string,
    modelId: string,
    toolCallIds: readonly string[],
    now = Date.now()
) => {
    for (const id of toolCallIds) {
        const entryKey = callKey(keyId, id);
        if (sticky.size >= STICKY_MAX && !sticky.has(entryKey)) sticky.delete(sticky.keys().next().value as string);
        sticky.set(entryKey, { modelId, at: now });
    }
};

const CONVERSATION_MS = 6 * 60 * 60_000;
const CONVERSATION_MAX = 5_000;
const conversations = new Map<string, { modelId: string; creditWeight: number; at: number }>();

/**
 * Checked again here: a concurrent message of the conversation may have moved
 * it to a stronger model since this request was routed. It may move down only
 * while it still names `unfitModelId`, the model this request could not use.
 */
const rememberConversation = (conversation: string, entry: RunnableEntry, now: number, unfitModelId: string | null) => {
    const existing = conversations.get(conversation);
    const onlyUp = !(unfitModelId !== null && existing?.modelId === unfitModelId);
    if (!conversationModelMayMove(existing, entry.capabilities.creditWeight, now, CONVERSATION_MS, onlyUp)) {
        return;
    }
    conversations.delete(conversation);
    if (conversations.size >= CONVERSATION_MAX) conversations.delete(conversations.keys().next().value as string);
    conversations.set(conversation, { modelId: entry.model.id, creditWeight: entry.capabilities.creditWeight, at: now });
};

/** Test-only: forget every conversation and tool-call memory. */
export const resetSmartAdaptiveMemory = () => {
    conversations.clear();
    sticky.clear();
    refused.clear();
    routing.clear();
};

/** The tool-call ids the trailing tool results of this request answer. */
const answeredToolCallIds = (request: ChatCompletionRequest) => {
    const messages = request.messages;
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role === "tool") index -= 1;
    if (index === messages.length - 1) return [];
    const assistant = messages[index];
    return assistant?.role === "assistant" ? (assistant.tool_calls ?? []).map((call) => call.id) : [];
};
const REFUSED_MS = 2 * 60_000;
const refused = new Map<string, number>();

/** Called when admission refused a Smart Adaptive request of this key. */
export const noteSmartAdaptiveRefusal = (keyId: string, now = Date.now()) => {
    if (refused.size >= STICKY_MAX) refused.delete(refused.keys().next().value as string);
    refused.set(keyId, now);
};

/** Idempotent requests routing now, by key and Idempotency-Key digest. */
const routing = new Map<string, Promise<Omit<SmartAdaptiveDecision, "remember" | "conversationDigest">>>();

/** Whether the paid router call may be made for this key now. */
export const smartAdaptiveRouterAllowed = async (
    key: { keyId: string; creditCap: number | null },
    now = Date.now()
) => {
    if (!smartAdaptiveRouterEnabled(process.env)) return false;
    const refusedAt = refused.get(key.keyId);
    if (refusedAt !== undefined && now - refusedAt < REFUSED_MS) return false;
    try {
        await assertOperationalFeatureEnabled("aiChatEnabled");
    } catch {
        return false;
    }
    if (key.creditCap !== null) {
        const totals = (await keyCreditTotals(prisma, [key.keyId])).get(key.keyId);
        if ((totals?.committed ?? 0) >= key.creditCap) return false;
    }
    return true;
};

const hasImage = (request: ChatCompletionRequest) =>
    request.messages.some(
        (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "image_url")
    );

/** Where the latest user message is, and the turn it belongs to. */
const latestTurn = (request: ChatCompletionRequest) => {
    const messages = request.messages;
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== "user") index -= 1;
    if (index < 0) return null;
    let previous: string | null = null;
    for (let at = index - 1; at >= 0; at -= 1) {
        const message = messages[at];
        if (message.role === "user") break;
        if (message.role === "assistant") {
            previous = chatText(message.content) || null;
            break;
        }
    }
    return {
        prompt: chatText(messages[index].content),
        previousAnswer: previous,
    };
};

export const smartAdaptiveCandidates = (request: ChatCompletionRequest, runnable: readonly RunnableEntry[]) => {
    const images = hasImage(request);
    const output = request.max_completion_tokens ?? request.max_tokens ?? 0;
    const input = estimatedChatInputTokens(request);
    return runnable.filter(
        ({ model, capabilities }) =>
            (!images || capabilities.vision) &&
            output <= capabilities.maxOutputTokens &&
            input + output <= capabilities.contextWindowTokens &&
            modelTakesRequestFeatures(request, {
                id: model.id,
                provider: model.provider,
                vision: capabilities.vision,
                reasoning: capabilities.reasoning,
                maxOutputTokens: capabilities.maxOutputTokens,
            })
    );
};

export const routeSmartAdaptive = async (input: {
    request: ChatCompletionRequest;
    runnable: readonly RunnableEntry[];
    keyId: string;
    userId: string;
    requestId: string;
    /** Asked only when a router call is next; false makes none (see smartAdaptiveRouterAllowed). */
    routerAllowed: () => Promise<boolean>;
    /** The request's Idempotency-Key digest, or null when it has none. */
    idempotencyKeyDigest: string | null;
    /** Digest of the request body: only an identical duplicate shares a pick. */
    requestDigest: string;
    /** The client's User-Agent, for the router and the log. */
    userAgent?: string | null;
    /** What the decision log names as the protocol; the route-only choice names itself. */
    logProtocol?: string;
    now?: number;
}): Promise<SmartAdaptiveDecision | null> => {
    // The models a request may take when the router does not pick: never a
    // frontier or apex model, on either API. Without one, Smart Adaptive is
    // not offered here (smartAdaptiveCapabilities) and nothing is decided.
    const defaults = input.runnable.filter((entry) => !isSmartAdaptiveOnlyModel(entry.model));
    if (defaults.length === 0) return null;
    const now = input.now ?? Date.now();
    const conversation = smartAdaptiveConversationKey(input.keyId, input.request);
    const known = conversations.get(conversation);
    const decision = await decideSmartAdaptive(input, defaults, conversation, now);
    // The remembered model may only be lowered when it no longer fits this
    // request (window, retirement) and something else answered.
    const knownFresh = known !== undefined && now - known.at < CONVERSATION_MS;
    const knownFits = knownFresh && smartAdaptiveCandidates(input.request, input.runnable).some((entry) => entry.model.id === known.modelId);
    const unfit = knownFresh && !knownFits ? known.modelId : null;
    console.info(
        JSON.stringify({
            event: "external_api_smart_adaptive_routed",
            requestId: input.requestId,
            protocol: input.logProtocol ?? "chat_completions",
            routedBy: decision.routedBy,
            modelId: decision.entry.model.id,
            held: decision.held ?? false,
            client: input.userAgent?.slice(0, 40) ?? null,
        })
    );
    return {
        ...decision,
        conversationDigest: createHash("sha256").update(conversation).digest("hex").slice(0, 32),
        // Called once admission accepted the request on this model.
        remember: () => rememberConversation(conversation, decision.entry, Date.now(), unfit),
    };
};

const decideSmartAdaptive = async (
    input: Parameters<typeof routeSmartAdaptive>[0],
    /** The runnable models that are not frontier or apex; never empty. */
    defaults: readonly RunnableEntry[],
    conversation: string,
    now: number
): Promise<Omit<SmartAdaptiveDecision, "remember" | "conversationDigest">> => {
    const eligible = smartAdaptiveCandidates(input.request, input.runnable);
    // Nothing fits: the default model answers, and its own limits refuse the
    // request with the usual error.
    const pool = eligible.length > 0 ? eligible : input.runnable;
    // When none of the models Smart Adaptive may default to fits, the default
    // model answers and its own limits refuse the request: a frontier or apex
    // model is only ever the router's pick beside them.
    const fitDefaults = pool.filter((entry) => !isSmartAdaptiveOnlyModel(entry.model));
    const fallbackPool = fitDefaults.length > 0 ? fitDefaults : defaults;
    const fallback = fallbackPool.find((entry) => entry.model.id === DEFAULT_MODEL_ID) ?? fallbackPool[0];
    const turn = latestTurn(input.request);

    // A tool round goes to the model that made the calls it answers, before
    // the router gate is asked: a gate closed for a while (a refusal two
    // minutes ago) must not hand a running task to another model.
    for (const id of answeredToolCallIds(input.request)) {
        const remembered = sticky.get(callKey(input.keyId, id));
        if (!remembered || now - remembered.at >= STICKY_MS) continue;
        const entry = eligible.find((candidate) => candidate.model.id === remembered.modelId);
        if (entry) return { entry, routedBy: "continued" };
        // Not a candidate for this request (it needs what the model lacks, or
        // the model was retired). The entry stays: another round answering the
        // same call may still fit it, and the ten-minute expiry clears it.
    }

    // The model already working on this conversation, if it still fits.
    const known = conversations.get(conversation);
    const current =
        known && now - known.at < CONVERSATION_MS
            ? eligible.find((candidate) => candidate.model.id === known.modelId)
            : undefined;
    // Nothing for the router to read, one candidate, or only router-only
    // models fit: no router call, and the conversation keeps its model (even
    // one only the router could have picked) or takes the default.
    if (!turn || !turn.prompt.trim() || eligible.length < 2 || fitDefaults.length === 0) {
        return current ? { entry: current, routedBy: "continued" } : { entry: fallback, routedBy: "default" };
    }
    const coding = smartAdaptiveCodingContext(input.request, input.userAgent ?? null, current?.model.id ?? null);

    // One router call per Idempotency-Key at a time in this process: a
    // concurrent duplicate waits for that call and takes the same model, and
    // admission answers it as the duplicate it is.
    // Keyed by the body as well: a different body under the same key is not a
    // duplicate of this request (admission refuses it as a reused key), so it
    // routes on its own rather than taking a pick made for another body.
    const flight = input.idempotencyKeyDigest
        ? `${input.keyId}\0${input.idempotencyKeyDigest}\0${input.requestDigest}`
        : null;
    const decide = async () => {
        const pending = flight ? routing.get(flight) : undefined;
        if (pending) return pending;
        const decision = (async (): Promise<Omit<SmartAdaptiveDecision, "remember" | "conversationDigest">> => {
            // Gate closed: the conversation keeps its model, or the default.
            if (!(await input.routerAllowed())) {
                return current ? { entry: current, routedBy: "continued" } : { entry: fallback, routedBy: "default" };
            }
            const routed = await pickWithSmartAdaptiveRouter({ ...input, eligible, fallback: current ?? fallback, ...turn, coding });
            if (routed.routedBy !== "router") {
                return current ? { entry: current, routedBy: "continued" } : routed;
            }
            const { entry, held } = escalateOnly(current, routed.entry);
            return held ? { entry, routedBy: "continued", held } : routed;
        })();
        if (!flight) return decision;
        routing.set(flight, decision);
        try {
            return await decision;
        } finally {
            routing.delete(flight);
        }
    };
    return decide();
};

export type SmartAdaptiveDecision = {
    entry: RunnableEntry;
    routedBy: "router" | "continued" | "default";
    /** The router picked a cheaper model and the conversation kept its own. */
    held?: boolean;
    /** Remember this model for the conversation; call once admission accepted it. */
    remember: () => void;
    /** SHA-256 prefix of the conversation key, for the receipt; never the key. */
    conversationDigest: string;
};

/**
 * One paid router call over these candidates, shared by Chat Completions and
 * the native protocols (lib/externalApiNativeSmartAdaptive.ts). The caller
 * has already asked the gate (smartAdaptiveRouterAllowed).
 */
export const pickWithSmartAdaptiveRouter = async (input: {
    userId: string;
    requestId: string;
    prompt: string;
    previousAnswer: string | null;
    eligible: readonly RunnableEntry[];
    fallback: RunnableEntry;
    coding: CodingRouterContext;
}): Promise<{ entry: RunnableEntry; routedBy: "router" | "default" }> => {
    const { eligible, fallback } = input;
    const pick = await pickAutoModelWithLlm({
        prompt: input.prompt,
        previousAnswer: input.previousAnswer,
        eligibleModelIds: eligible.map((entry) => entry.model.id),
        // Every runtime model, not just the candidates: the router model set in
        // Admin › Routing is looked up here and need not be a candidate itself.
        // A dedicated coding row is not a runtime model; it joins as itself.
        models: withCandidateModels(await getRuntimeModels(), eligible),
        creditsByModelId: Object.fromEntries(eligible.map((entry) => [entry.model.id, entry.capabilities.creditWeight])),
        ruleModelId: fallback.model.id,
        taskKind: "external_api",
        userId: input.userId,
        // No conversation: the router keeps no decision row, so no prompt is stored.
        conversationId: null,
        traceId: input.requestId,
        rewriteAllowed: false,
        coding: input.coding,
    }).catch(() => null);
    // The router's answer only ever names a model already eligible here.
    const picked = pick ? eligible.find((entry) => entry.model.id === pick.modelId) : undefined;
    return { entry: picked ?? fallback, routedBy: picked ? "router" : "default" };
};
