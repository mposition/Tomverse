import type { ImageModelProfile } from "@/lib/imageModelRegistry";
import {
    IMAGE_QUALITY_BY_PRESET,
    type ImagePreset,
} from "@/lib/imageGenerationPricing";

/**
 * The pure half of the chat image-intent call (lib/chatImageIntent.ts): one
 * small model call that answers "is this chat message a request to create an
 * image?" and, when it is, triages it -- which image model and preset the
 * request needs, a stronger model and a finer preset for a complex image, a
 * cheaper one for a simple image. A chat send then goes straight to the image
 * workspace with that choice instead of to an answer explaining that chat
 * cannot draw.
 *
 * Made by the Auto router's model (Admin Console › Routing), behind its own
 * image triage switch there; off unless both are set. The call only routes: the image workspace still quotes the price and
 * spends credits under its own consent rules (docs/policy/image-generation.md).
 */

/** Long enough to read the request; the rest of a long message adds nothing. */
export const CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS = 2_000;

/** One small JSON object plus slack for providers that count reasoning. */
export const CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS = 160;

/** The send waits on this call, so a slow answer reads as "not an image". */
export const CHAT_IMAGE_INTENT_TIMEOUT_MS = 4_000;

/** The composer's wait: the server's deadline plus the round trip. */
export const CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS = 5_000;

const PRESETS: readonly ImagePreset[] = ["draft", "standard", "final"];

/** What the triage reads about one image model. Square size is the reference. */
export type ChatImageModelCandidate = {
    id: string;
    name: string;
    /** Whose model it is (`imageModelOwner`): what a chat model is matched by. */
    owner: string;
    latency: ImageModelProfile["latencyClass"];
    /** Credits for one 1024x1024 image, per preset the model offers. */
    credits: Partial<Record<ImagePreset, number>>;
};

/**
 * `modelIds` empty or a preset of null means "the workspace default": the
 * triage never hands the workspace a choice it could not price.
 */
export type ChatImageDecision =
    | { image: false }
    | { image: true; modelIds: string[]; preset: ImagePreset | null };

/** Enabled models with at least one square price, in catalogue order. */
export const chatImageModelCandidates = (
    models: readonly Pick<
        ImageModelProfile,
        "id" | "name" | "latencyClass" | "prices" | "disabledReason" | "provider" | "modelOwner"
    >[]
): ChatImageModelCandidate[] =>
    models.flatMap((model) => {
        if (model.disabledReason !== null) return [];
        const credits: Partial<Record<ImagePreset, number>> = {};
        for (const preset of PRESETS) {
            const price = model.prices.find(
                (option) =>
                    option.size === "1024x1024" &&
                    option.quality === IMAGE_QUALITY_BY_PRESET[preset]
            );
            if (price) credits[preset] = price.credits;
        }
        if (Object.keys(credits).length === 0) return [];
        return [
            {
                id: model.id,
                name: model.name,
                owner: model.modelOwner ?? model.provider,
                latency: model.latencyClass,
                credits,
            },
        ];
    });

/**
 * Review's answer to "which image models": the image model made by the same
 * company as each selected chat model, in the order the chat models were
 * chosen, one per company, capped at the comparison limit. A chat model whose
 * maker has no enabled image model (Anthropic, DeepSeek, ...) contributes
 * nothing. Empty means none matched, and the triage picks instead.
 */
export const imageCandidatesForChatModels = (
    chatModels: readonly { provider: string }[],
    candidates: readonly ChatImageModelCandidate[],
    maxModels: number
): ChatImageModelCandidate[] => {
    const chosen: ChatImageModelCandidate[] = [];
    for (const chatModel of chatModels) {
        const match = candidates.find((candidate) => candidate.owner === chatModel.provider);
        if (match && !chosen.includes(match)) chosen.push(match);
    }
    return chosen.slice(0, Math.max(0, maxModels));
};

export const CHAT_IMAGE_ROUTING_CRITERIA = [
    "image=true when the user wants a picture made: draw, paint, generate, render or illustrate a photo, illustration, artwork, logo, poster, wallpaper, character, scene or similar visual, in any language.",
    "image=false for everything else, including:",
    "- questions about images or about how image generation works;",
    "- describing, analysing or editing an attached or existing image;",
    "- code or text that produces graphics (SVG, HTML/CSS, charts, plots, diagrams, ASCII art);",
    "- writing a prompt for another image tool;",
    "- messages that only mention a picture in passing.",
    "When unsure, answer image=false.",
    "",
    "When image=true, choose the cheapest model and preset that will do the request well:",
    "- draft: a quick sketch, a simple icon or symbol, a rough idea, or the user asks for something fast or cheap;",
    "- standard: the ordinary request, one clear subject or scene;",
    "- final: detailed or photorealistic work, several subjects, legible text inside the image, posters or other final deliverables, or the user asks for the best quality.",
    "Give simple requests a cheaper or faster model and complex ones a stronger, pricier model. Use only a preset the chosen model lists.",
].join("\n");

export const CHAT_IMAGE_INTENT_SYSTEM = [
    "You route messages sent to a chat assistant that cannot draw.",
    "A separate image generator exists. Decide whether this message asks for a new image to be created and, if it does, which image model and preset should make it.",
    CHAT_IMAGE_ROUTING_CRITERIA,
    "When image=false, fill modelId and preset with any listed value; they are ignored.",
].join("\n");

/** The message the model sees: trimmed and capped. Empty means no call. */
export const chatImageIntentPrompt = (text: string): string =>
    text.trim().slice(0, CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS);

/**
 * The model list, then the message. `fixed` says the user already chose these
 * models (Review), so only the preset is the model's to decide.
 */
export const chatImageIntentUserMessage = (
    text: string,
    candidates: readonly ChatImageModelCandidate[],
    options: { fixed?: boolean } = {}
): string =>
    [
        options.fixed
            ? "The user already chose these image models and each will make the image; choose only the preset (one every model lists). Image models (credits per 1024x1024 image, by preset):"
            : "Image models (credits per 1024x1024 image, by preset):",
        ...candidates.map((candidate) => {
            const prices = PRESETS.filter((preset) => candidate.credits[preset] !== undefined)
                .map((preset) => `${preset} ${candidate.credits[preset]}`)
                .join(", ");
            return `- ${candidate.id} (${candidate.name}; ${candidate.latency}): ${prices}`;
        }),
        "",
        "Message:",
        chatImageIntentPrompt(text),
    ].join("\n");

export const chatImageIntentOutputSchema = (
    candidates: readonly ChatImageModelCandidate[]
) => ({
    type: "object" as const,
    properties: {
        image: { type: "boolean" as const },
        modelId: { type: "string" as const, enum: candidates.map((candidate) => candidate.id) },
        preset: { type: "string" as const, enum: [...PRESETS] },
    },
    required: ["image", "modelId", "preset"],
    additionalProperties: false as const,
});

const isPreset = (value: unknown): value is ImagePreset =>
    typeof value === "string" && (PRESETS as readonly string[]).includes(value);

/**
 * Only an explicit `image: true` routes. A model or preset outside the list --
 * or a preset the chosen model does not offer -- is dropped rather than
 * trusted, and the workspace keeps its own default for it.
 *
 * With `fixedModels` (Review: the user already chose the models) the answer's
 * model is ignored and those models are the result; its preset is kept only
 * when every one of them offers it, because the workspace cannot price a
 * comparison in which one model lacks the preset.
 */
export const parseChatImageIntentOutput = (
    output: unknown,
    candidates: readonly ChatImageModelCandidate[],
    fixedModels: readonly ChatImageModelCandidate[] = []
): ChatImageDecision => {
    if (typeof output !== "object" || output === null) return { image: false };
    const value = output as { image?: unknown; modelId?: unknown; preset?: unknown };
    if (value.image !== true) return { image: false };
    const chosen =
        fixedModels.length > 0
            ? fixedModels
            : candidates.filter((entry) => entry.id === value.modelId);
    if (chosen.length === 0) return { image: true, modelIds: [], preset: null };
    const preset =
        isPreset(value.preset) &&
        chosen.every((entry) => entry.credits[value.preset as ImagePreset] !== undefined)
            ? value.preset
            : null;
    return { image: true, modelIds: chosen.map((entry) => entry.id), preset };
};

/** The client's reading of the route's JSON; anything malformed is chat. */
export const readChatImageDecision = (data: unknown): ChatImageDecision => {
    if (typeof data !== "object" || data === null) return { image: false };
    const value = data as { image?: unknown; modelIds?: unknown; preset?: unknown };
    if (value.image !== true) return { image: false };
    return {
        image: true,
        modelIds: Array.isArray(value.modelIds)
            ? value.modelIds.filter(
                  (modelId): modelId is string => typeof modelId === "string" && modelId !== ""
              )
            : [],
        preset: isPreset(value.preset) ? value.preset : null,
    };
};
