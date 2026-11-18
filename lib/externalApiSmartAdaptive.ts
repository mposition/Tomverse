import "server-only";
import { createHash } from "node:crypto";
import { pickAutoModelWithLlm } from "@/lib/autoLlmRouter";
import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import type { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { smartAdaptiveRouterEnabled } from "@/lib/externalApiCatalogCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import type { ChatCompletionRequest } from "@/lib/openAiChatProtocol";

type RunnableEntry = Awaited<ReturnType<typeof externalApiRunnableModels>>[number];

/**
 * Smart Adaptive for the external API: Chat's own LLM router picks which
 * catalogue model answers a request. See docs/policy/external-api.md.
 *
 * Candidates are the runnable models that fit this request: images only to a
 * model that reads them, and input plus requested output within the model's
 * window. Without the router switch, or when the router gives no answer, the
 * default model answers if it fits, otherwise the first candidate.
 *
 * A coding client sends every tool round as a new request, so routing each one
 * afresh would let the model change half-way through a task. A request that
 * only carries tool results back therefore keeps the model picked for the user
 * message it continues. The pick is remembered in this process, under a
 * digest of the key and the messages up to that user message -- no content is
 * kept, and a miss (another instance, a restart, ten minutes later) simply
 * routes again.
 */

const STICKY_MS = 10 * 60_000;
const STICKY_MAX = 2_000;
const sticky = new Map<string, { modelId: string; at: number }>();

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
        ({ capabilities }) =>
            (!images || capabilities.vision) &&
            output <= capabilities.maxOutputTokens &&
            input + output <= capabilities.contextWindowTokens
    );
};

export const routeSmartAdaptive = async (input: {
    request: ChatCompletionRequest;
    runnable: readonly RunnableEntry[];
    keyId: string;
    userId: string;
    requestId: string;
    now?: number;
}): Promise<{ entry: RunnableEntry; routedBy: "router" | "continued" | "default" }> => {
    const eligible = smartAdaptiveCandidates(input.request, input.runnable);
    // Nothing fits: the default model answers, and its own limits refuse the
    // request with the usual error.
    const pool = eligible.length > 0 ? eligible : input.runnable;
    const fallback = pool.find((entry) => entry.model.id === DEFAULT_MODEL_ID) ?? pool[0];
    const turn = latestTurn(input.request);
    if (!turn || eligible.length < 2 || !smartAdaptiveRouterEnabled(process.env)) {
        return { entry: fallback, routedBy: "default" };
    }

    const now = input.now ?? Date.now();
    const digest = createHash("sha256").update(input.keyId).update("\0").update(turn.digestSource).digest("hex");
    const remembered = sticky.get(digest);
    if (turn.continuesToolLoop && remembered && now - remembered.at < STICKY_MS) {
        const entry = eligible.find((candidate) => candidate.model.id === remembered.modelId);
        if (entry) return { entry, routedBy: "continued" };
    }

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
    const entry = picked ?? fallback;

    if (sticky.size >= STICKY_MAX) sticky.delete(sticky.keys().next().value as string);
    sticky.set(digest, { modelId: entry.model.id, at: now });
    return { entry, routedBy: picked ? "router" : "default" };
};
