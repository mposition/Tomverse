import "server-only";
import { createHash } from "node:crypto";
import type { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { nativeSmartAdaptiveDefaultId } from "@/lib/externalApiCatalogCore";
import { estimateNativeInput, isRecord, NativeProtocolError } from "@/lib/externalApiNativeCore";
import { NATIVE_PROTOCOL_PROVIDER } from "@/lib/externalApiProtocols";
import { pickWithSmartAdaptiveRouter } from "@/lib/externalApiSmartAdaptive";
import {
    escalateOnly,
    isNativeOutput,
    nativeCodingContext,
    nativeHistory,
    nativeText,
    nativeUserTurn,
    type NativeSmartProtocol,
} from "@/lib/externalApiSmartAdaptiveCore";
import { DEFAULT_MODEL_ID } from "@/lib/models";

type RunnableEntry = Awaited<ReturnType<typeof externalApiRunnableModels>>[number];
export type { NativeSmartProtocol };

/**
 * Smart Adaptive on the native protocols: Claude Code (Anthropic Messages)
 * routes among Anthropic models only, Codex (Responses) among OpenAI models
 * only. See docs/policy/external-api.md, section 10.
 *
 * One pick per conversation. A coding tool sends every round as a new request
 * carrying the whole history, and both providers drop earlier reasoning a new
 * model cannot read (Anthropic: thinking blocks are bound to the model that
 * produced them; OpenAI: incompatible encrypted reasoning is omitted). Neither
 * fails the request, but the reasoning and the prompt cache are lost. So the
 * first request of a conversation is routed, and every later one goes to the
 * same model.
 *
 * The conversation is known by the id the client already sends: Codex's
 * `prompt_cache_key` (its thread id, also its `session-id` header), Claude
 * Code's session (`x-claude-code-session-id`, or the session in
 * `metadata.user_id`). Without one, by the opening of the history (the
 * messages before the first model output), which an append-only conversation
 * keeps. The pin lives in this process; a miss on a request that already
 * carries model output (another instance, a restart, an expired pin) is never
 * routed again: it takes the provider's default model and pins that. A model
 * switch there costs reasoning, never the request.
 *
 * The paid router call is made on a conversation's first request and on each
 * later message the user wrote (not a tool round), behind the same gate and
 * switch as Chat Completions (smartAdaptiveRouterAllowed), with the coding
 * guidance and what the request shows of the task. On a later message the
 * model only moves up (escalateOnly): a pick cheaper than the pinned model
 * keeps the pin, a stronger one moves it, and the move is pinned only once
 * admission accepted it (`commit`), so a model the account cannot pay for
 * never takes the conversation. A user message with no pin (another
 * instance, a restart) is routed like a first request.
 * A free call (token count) never routes: the pin, or the default.
 * Every decision is logged as `external_api_smart_adaptive_routed`.
 */

const PIN_MS = 6 * 60 * 60_000;
const PIN_MAX = 5_000;
const pins = new Map<string, { modelId: string; at: number }>();
const routing = new Map<string, Promise<NativeSmartDecision>>();

export type NativeSmartDecision = {
    entry: RunnableEntry;
    routedBy: "router" | "continued" | "default";
    /** The router picked a cheaper model and the conversation kept its pin. */
    held?: boolean;
    /** Pins a move to a stronger model; called once admission accepted it. */
    commit?: () => void;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

const pin = (pinKey: string, modelId: string, now: number) => {
    pins.delete(pinKey);
    if (pins.size >= PIN_MAX) pins.delete(pins.keys().next().value as string);
    pins.set(pinKey, { modelId, at: now });
};

/** Whether the request already carries something a model produced. */
export const nativeConversationUnderWay = (protocol: NativeSmartProtocol, body: Record<string, unknown>) =>
    nativeHistory(protocol, body).some((item) => isNativeOutput(protocol, item));

/** The conversation this request belongs to, as the client identifies it. */
export const nativeConversationId = (
    protocol: NativeSmartProtocol,
    request: Request,
    body: Record<string, unknown>
): string => {
    if (protocol === "responses") {
        const id =
            (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) ||
            request.headers.get("session-id") ||
            request.headers.get("thread-id");
        if (id) return `client:${id.slice(0, 200)}`;
    } else {
        const header = request.headers.get("x-claude-code-session-id");
        if (header) return `client:${header.slice(0, 200)}`;
        const userId = isRecord(body.metadata) ? body.metadata.user_id : undefined;
        if (typeof userId === "string" && /session/i.test(userId)) return `client:${digest(userId)}`;
    }
    const items = nativeHistory(protocol, body);
    const firstOutput = items.findIndex((item) => isNativeOutput(protocol, item));
    const opening = firstOutput < 0 ? items : items.slice(0, firstOutput);
    return `opening:${digest(JSON.stringify([body.system ?? body.instructions ?? null, opening]))}`;
};

/** The latest user text, for the router. */
export const nativeLatestPrompt = (protocol: NativeSmartProtocol, body: Record<string, unknown>) => {
    const items = nativeHistory(protocol, body);
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (isRecord(item) && item.role === "user") {
            const text = nativeText(item.content);
            if (text) return text;
        }
    }
    return "";
};

export const routeNativeSmartAdaptive = async (
    input: Parameters<typeof decideNativeSmartAdaptive>[0]
): Promise<NativeSmartDecision | null> => {
    const decision = await decideNativeSmartAdaptive(input);
    if (decision && !input.free) {
        console.info(
            JSON.stringify({
                event: "external_api_smart_adaptive_routed",
                requestId: input.requestId,
                protocol: input.protocol,
                routedBy: decision.routedBy,
                modelId: decision.entry.model.id,
                held: decision.held ?? false,
                client: input.request.headers.get("user-agent")?.slice(0, 40) ?? null,
            })
        );
    }
    return decision;
};

const decideNativeSmartAdaptive = async (input: {
    protocol: NativeSmartProtocol;
    request: Request;
    body: Record<string, unknown>;
    runnable: readonly RunnableEntry[];
    keyId: string;
    userId: string;
    requestId: string;
    /** Asked only when a router call is next; false makes none. */
    routerAllowed: () => Promise<boolean>;
    /**
     * The protocol's own request check and rewrite for one model (the same
     * `prepare` dispatch uses): throws when that model would refuse the
     * request (e.g. a thinking budget above its output limit).
     */
    prepare: (model: { apiModel: string; maxOutputTokens: number }) => { payload: unknown; outputLimit: number };
    /** A free call (token count) reads the pin but never routes or pins. */
    free?: boolean;
    now?: number;
}): Promise<NativeSmartDecision | null> => {
    const provider = NATIVE_PROTOCOL_PROVIDER[input.protocol];
    const pool = input.runnable.filter(
        (entry) => entry.model.provider === provider && entry.capabilities.protocols.includes(input.protocol)
    );
    if (pool.length === 0) return null;
    // A candidate is a model this request passes on, exactly as it would be
    // sent: its own validation, then the estimate of the rewritten body plus
    // the output the gateway would reserve on it within its window.
    let refusal: unknown = null;
    let unreadImage = false;
    const fits = pool.filter(({ model, capabilities }) => {
        let prepared: { payload: unknown; outputLimit: number };
        try {
            prepared = input.prepare({ apiModel: model.apiModel, maxOutputTokens: capabilities.maxOutputTokens });
        } catch (error) {
            refusal ??= error;
            return false;
        }
        const estimate = estimateNativeInput(prepared.payload, provider);
        if (estimate.images > 0 && !capabilities.vision) {
            unreadImage = true;
            return false;
        }
        return estimate.breakdown.rawTotal + prepared.outputLimit <= capabilities.contextWindowTokens;
    });
    // Nothing of this provider can take the request: refused here, before any
    // router call, reservation or dispatch.
    if (fits.length === 0) {
        if (refusal) throw refusal;
        throw unreadImage
            ? new NativeProtocolError(400, "image_input_unsupported", "No model available to Smart Adaptive here reads images.", "messages")
            : new NativeProtocolError(
                  400,
                  "context_length_exceeded",
                  "The request is too long for every model available to Smart Adaptive here. Compact the conversation or lower the output limit.",
                  "messages"
              );
    }
    const candidates = fits;
    const defaultId = nativeSmartAdaptiveDefaultId(
        candidates.map((entry) => entry.capabilities),
        DEFAULT_MODEL_ID
    );
    const fallback = candidates.find((entry) => entry.model.id === defaultId) ?? candidates[0];
    const now = input.now ?? Date.now();
    const pinKey = `${input.keyId}\0${input.protocol}\0${nativeConversationId(input.protocol, input.request, input.body)}`;

    const prompt = nativeLatestPrompt(input.protocol, input.body);
    const userTurn = nativeUserTurn(input.protocol, input.body);
    const router = (current: RunnableEntry | undefined) =>
        pickWithSmartAdaptiveRouter({
            userId: input.userId,
            requestId: input.requestId,
            prompt,
            previousAnswer: null,
            eligible: candidates,
            fallback: current ?? fallback,
            coding: nativeCodingContext(input.protocol, input.request.headers.get("user-agent"), input.body, current?.model.id ?? null),
        });

    const pinned = pins.get(pinKey);
    if (pinned && now - pinned.at < PIN_MS) {
        const current = candidates.find((candidate) => candidate.model.id === pinned.modelId);
        if (current) {
            if (!input.free) pin(pinKey, current.model.id, now);
            if (input.free || !userTurn || candidates.length < 2 || !prompt) return { entry: current, routedBy: "continued" };
            // A message the user wrote: the router may move the conversation
            // to a stronger model, never to a cheaper one.
            if (!(await input.routerAllowed())) return { entry: current, routedBy: "continued" };
            const routed = await router(current);
            if (routed.routedBy !== "router" || routed.entry.model.id === current.model.id) {
                return { entry: current, routedBy: "continued" };
            }
            const { entry, held } = escalateOnly(current, routed.entry);
            if (held) return { entry, routedBy: "continued", held };
            return { entry, routedBy: "router", commit: () => pin(pinKey, entry.model.id, Date.now()) };
        }
        // The pinned model cannot take this request any more (the history
        // outgrew its window, or it was retired): another of the provider's
        // models answers rather than a refusal, and the pin moves with it.
    }
    if (input.free) return { entry: fallback, routedBy: "default" };

    const settle = (decision: NativeSmartDecision) => {
        pin(pinKey, decision.entry.model.id, now);
        return decision;
    };
    // A tool round with no pin keeps to the default; a message the user wrote
    // is routed like a first request.
    if ((nativeConversationUnderWay(input.protocol, input.body) && !userTurn) || candidates.length < 2 || !prompt) {
        return settle({ entry: fallback, routedBy: "default" });
    }
    // Concurrent first requests of one conversation share one router call;
    // each still takes the shared pick only if it is one of its own candidates.
    // A waiter that cannot take it answers on its own default without moving
    // the pin; its next request re-checks the pin like any other.
    const pending = routing.get(pinKey);
    if (pending) {
        const shared = await pending;
        const entry = candidates.find((candidate) => candidate.model.id === shared.entry.model.id);
        return entry ? { entry, routedBy: shared.routedBy } : { entry: fallback, routedBy: "default" };
    }
    const decision = (async () =>
        settle(
            (await input.routerAllowed()) ? await router(undefined) : { entry: fallback, routedBy: "default" }
        ))();
    routing.set(pinKey, decision);
    try {
        return await decision;
    } finally {
        routing.delete(pinKey);
    }
};

/** Test-only: forget every pin. */
export const resetNativeSmartAdaptivePins = () => {
    pins.clear();
    routing.clear();
};
