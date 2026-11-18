import "server-only";
import { createHash } from "node:crypto";
import { pickAutoModelWithLlm } from "@/lib/autoLlmRouter";
import type { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { ChatCompletionRequest } from "@/lib/openAiChatProtocol";

type RunnableEntry = Awaited<ReturnType<typeof externalApiRunnableModels>>[number];

/**
 * Smart Adaptive for the external API: Chat's own LLM router picks which of
 * the account's listed models answers a request. See docs/policy/external-api.md.
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

export const routeSmartAdaptive = async (input: {
    request: ChatCompletionRequest;
    runnable: readonly RunnableEntry[];
    keyId: string;
    userId: string;
    requestId: string;
    now?: number;
}): Promise<{ entry: RunnableEntry; routedBy: "router" | "continued" | "default" }> => {
    const images = hasImage(input.request);
    // Operator list order, so the default is the first model the operator listed.
    const eligible = input.runnable.filter((entry) => !images || entry.capabilities.vision);
    const fallback = eligible[0] ?? input.runnable[0];
    const turn = latestTurn(input.request);
    if (!turn || eligible.length < 2) return { entry: fallback, routedBy: "default" };

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

/** Test seam: forget remembered picks. */
export const resetSmartAdaptiveMemory = () => sticky.clear();
