import "server-only";
import { createHash } from "node:crypto";
import { assertOperationalFeatureEnabled } from "@/lib/appSettings";
import { pickAutoModelWithLlm } from "@/lib/autoLlmRouter";
import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import { keyCreditTotals } from "@/lib/externalApiAdmission";
import type { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { smartAdaptiveRouterEnabled } from "@/lib/externalApiCatalogCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { DEFAULT_MODEL_ID } from "@/lib/models";
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
 * model answers if it fits, otherwise the first candidate.
 *
 * A coding client sends every tool round as a new request, so routing each one
 * afresh would let the model change half-way through a task. A request that
 * only carries tool results back therefore keeps the model picked for the user
 * message it continues. The pick is remembered in this process, under a
 * digest of the key and the messages up to that user message, and only once
 * admission let the request through -- so the memory always holds the model
 * that answered, never one a refused or concurrent request decided on. No
 * content is kept, and a miss (another instance, a restart, ten minutes later)
 * simply routes again.
 */

const STICKY_MS = 10 * 60_000;
const STICKY_MAX = 2_000;
const sticky = new Map<string, { modelId: string; at: number }>();
const REFUSED_MS = 2 * 60_000;
const refused = new Map<string, number>();

/** Called when admission refused a Smart Adaptive request of this key. */
export const noteSmartAdaptiveRefusal = (keyId: string, now = Date.now()) => {
    if (refused.size >= STICKY_MAX) refused.delete(refused.keys().next().value as string);
    refused.set(keyId, now);
};

/** Idempotent requests routing now, by key and Idempotency-Key digest. */
const routing = new Map<string, Promise<{ entry: RunnableEntry; routedBy: "router" | "default" }>>();

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

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
                .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
                .filter(Boolean)
                .join("\n")
          : "";

const hasImage = (request: ChatCompletionRequest) =>
    request.messages.some(
        (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "image_url")
    );

/** A rough size of the request, only to leave out models it cannot fit. */
const estimatedInputTokens = (request: ChatCompletionRequest) =>
    estimateTextTokens(
        request.messages
            .map((message) =>
                [
                    textOf(message.content),
                    ...(message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.function.arguments) : []),
                ].join("\n")
            )
            .join("\n") + JSON.stringify(request.tools ?? [])
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
            previous = textOf(message.content) || null;
            break;
        }
    }
    return {
        prompt: textOf(messages[index].content),
        previousAnswer: previous,
        continuesToolLoop: index < messages.length - 1,
        digestSource: JSON.stringify(messages.slice(0, index + 1)),
    };
};

export const smartAdaptiveCandidates = (request: ChatCompletionRequest, runnable: readonly RunnableEntry[]) => {
    const images = hasImage(request);
    const output = request.max_completion_tokens ?? request.max_tokens ?? 0;
    const input = estimatedInputTokens(request);
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
    now?: number;
}): Promise<SmartAdaptiveDecision> => {
    const eligible = smartAdaptiveCandidates(input.request, input.runnable);
    // Nothing fits: the default model answers, and its own limits refuse the
    // request with the usual error.
    const pool = eligible.length > 0 ? eligible : input.runnable;
    const fallback = pool.find((entry) => entry.model.id === DEFAULT_MODEL_ID) ?? pool[0];
    const turn = latestTurn(input.request);
    if (!turn || eligible.length < 2) return { entry: fallback, routedBy: "default", admitted: () => undefined };

    // A tool round keeps its remembered pick before the router gate is asked:
    // a gate closed for a while (a refusal two minutes ago) must not hand a
    // running task to another model.
    const now = input.now ?? Date.now();
    const digest = createHash("sha256").update(input.keyId).update("\0").update(turn.digestSource).digest("hex");
    const remembered = sticky.get(digest);
    // Only a request that admission let through is remembered: its model is
    // the one that actually answered, whatever a concurrent request decided.
    const remember = (modelId: string) => () => {
        if (sticky.size >= STICKY_MAX && !sticky.has(digest)) sticky.delete(sticky.keys().next().value as string);
        sticky.set(digest, { modelId, at: Date.now() });
    };
    if (turn.continuesToolLoop && remembered && now - remembered.at < STICKY_MS) {
        const entry = eligible.find((candidate) => candidate.model.id === remembered.modelId);
        if (entry) return { entry, routedBy: "continued", admitted: () => undefined };
        // No longer a candidate (retired, or this round needs what it lacks).
        sticky.delete(digest);
    }

    // One router call per Idempotency-Key at a time in this process: a
    // concurrent duplicate waits for that call and takes the same model, so
    // whichever of them admission lets through answered with the model the
    // tool-loop memory records; the other gets the duplicate's receipt.
    // Keyed by the body as well: a different body under the same key is not a
    // duplicate of this request (admission refuses it as a reused key), so it
    // routes on its own rather than taking a pick made for another body.
    const flight = input.idempotencyKeyDigest
        ? `${input.keyId}\0${input.idempotencyKeyDigest}\0${input.requestDigest}`
        : null;
    const decide = async () => {
        const pending = flight ? routing.get(flight) : undefined;
        if (pending) return pending;
        const decision = (async () =>
            (await input.routerAllowed())
                ? routeWithRouter(input, eligible, fallback, turn)
                : { entry: fallback, routedBy: "default" as const })();
        if (!flight) return decision;
        routing.set(flight, decision);
        try {
            return await decision;
        } finally {
            routing.delete(flight);
        }
    };
    const { entry, routedBy } = await decide();
    return { entry, routedBy, admitted: remember(entry.model.id) };
};

export type SmartAdaptiveDecision = {
    entry: RunnableEntry;
    routedBy: "router" | "continued" | "default";
    /**
     * Call once admission has let the request through: only then is its model
     * remembered for the tool rounds that continue this user message.
     */
    admitted: () => void;
};

const routeWithRouter = async (
    input: { userId: string; requestId: string },
    eligible: readonly RunnableEntry[],
    fallback: RunnableEntry,
    turn: NonNullable<ReturnType<typeof latestTurn>>
): Promise<{ entry: RunnableEntry; routedBy: "router" | "default" }> => {
    const pick = await pickAutoModelWithLlm({
        prompt: turn.prompt,
        previousAnswer: turn.previousAnswer,
        eligibleModelIds: eligible.map((entry) => entry.model.id),
        // Every runtime model, not just the candidates: the router model set in
        // Admin › Routing is looked up here and need not be a candidate itself.
        models: await getRuntimeModels(),
        creditsByModelId: Object.fromEntries(eligible.map((entry) => [entry.model.id, entry.capabilities.creditWeight])),
        ruleModelId: fallback.model.id,
        taskKind: "external_api",
        userId: input.userId,
        // No conversation: the router keeps no decision row, so no prompt is stored.
        conversationId: null,
        traceId: input.requestId,
        rewriteAllowed: false,
    }).catch(() => null);
    // The router's answer only ever names a model already eligible here.
    const picked = pick ? eligible.find((entry) => entry.model.id === pick.modelId) : undefined;
    return { entry: picked ?? fallback, routedBy: picked ? "router" : "default" };
};
