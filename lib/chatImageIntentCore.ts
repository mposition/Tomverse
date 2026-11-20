import type { ImageModelProfile } from "@/lib/imageModelRegistry";
import { ROUTING_CALL_MAX_OUTPUT_TOKENS } from "@/lib/routingCallLimits";
import {
    IMAGE_EDIT_SOURCE_MEDIA_TYPES,
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

/**
 * The shared routing-call ceiling (lib/routingCallLimits.ts), for a plain
 * decision and for a follow-up that also writes the whole new prompt: an
 * OpenAI reasoning model counts its reasoning against it, and a ceiling it hits
 * returns no object.
 */
export const CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS = ROUTING_CALL_MAX_OUTPUT_TOKENS;

/**
 * The send waits on this call, so a slow answer reads as "not an image".
 *
 * Measured on dev 2026-10-20 with gpt-6-luna as the router model: the Auto
 * router's own call took 3.1 s and the first image-intent call, at a 4 s
 * deadline, was cut off at 4,005 ms -- every image request then fell through
 * to a text answer. The deadline only bounds the worst case; a send waits as
 * long as the call actually takes.
 */
export const CHAT_IMAGE_INTENT_TIMEOUT_MS = 8_000;

/**
 * A follow-up ("make it bluer") writes the whole new prompt as well as the
 * decision, so it gets the time to write it.
 */
export const CHAT_IMAGE_INTENT_FOLLOW_UP_TIMEOUT_MS = 12_000;

/** The composer's wait: the longest server deadline plus the round trip. */
export const CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS = 14_000;

const PRESETS: readonly ImagePreset[] = ["draft", "standard", "final"];

/** What the triage reads about one image model. Square size is the reference. */
export type ChatImageModelCandidate = {
    id: string;
    name: string;
    latency: ImageModelProfile["latencyClass"];
    /**
     * How long this model's recent generations here actually took, in whole
     * seconds (the median). Absent until there are enough of them; the band
     * above is the profile's rough guess and is all the call has then.
     */
    seconds?: number;
    /** Credits for one 1024x1024 image, per preset the model offers. */
    credits: Partial<Record<ImagePreset, number>>;
    /** What the model is good and bad at (the profile's routingNote), when it has one. */
    note?: string;
};

/**
 * `prompt` is set only for a follow-up to the conversation's previous image
 * ("make it bluer"): the complete prompt for the new image, the previous one
 * with the change applied. Null means the message itself is the prompt.
 */
export type ChatImageDecision =
    | { image: false }
    | {
          image: true;
          modelId: string | null;
          preset: ImagePreset | null;
          prompt: string | null;
          /**
           * Change the photo attached to this message rather than draw a new
           * image. Only ever true when the call was told a photo is attached.
           */
          edit: boolean;
          /** The recorded routing decision (lib/imageRoutingDecisions.ts), when one was written. */
          routingDecisionId?: string;
      };

/** Prepared under the same image gates for standalone and combined routing. */
export type ChatImageIntentContext = {
    modelId: string;
    candidates: readonly ChatImageModelCandidate[];
    previousImagePrompt: string | null;
    attachedPhoto: boolean;
    prompt: string;
    /** Exact bounded message, to share it with the combined router when equal. */
    message?: string;
    maxOutputTokens: number;
    timeoutMs: number;
    /** The image routing criteria in force (the promoted image guidance, or the default). */
    criteria?: string;
};

/**
 * The longest follow-up rewrite accepted. The call is told this limit; a
 * rewrite over it is refused, never cut -- the end of the prompt is where
 * the change ("now in blue") usually is, and an image made from a prompt
 * missing it would be charged for the wrong picture.
 */
export const CHAT_IMAGE_INTENT_MAX_REWRITE_CHARS = 1_500;

/** Fewer finished generations than this say too little about a model's speed. */
export const IMAGE_SPEED_MIN_SAMPLES = 3;

/**
 * The median seconds a model's finished generations took, per model id, for
 * models with at least IMAGE_SPEED_MIN_SAMPLES of them. The median, so one
 * stuck request does not make a model look slow.
 */
export const typicalImageSeconds = (
    runs: readonly { modelId: string; startedAt: Date | null; completedAt: Date | null }[]
): Record<string, number> => {
    const byModel = new Map<string, number[]>();
    for (const run of runs) {
        if (!run.startedAt || !run.completedAt) continue;
        const seconds = (run.completedAt.getTime() - run.startedAt.getTime()) / 1000;
        if (!Number.isFinite(seconds) || seconds <= 0) continue;
        byModel.set(run.modelId, [...(byModel.get(run.modelId) ?? []), seconds]);
    }
    const typical: Record<string, number> = {};
    for (const [modelId, seconds] of byModel) {
        if (seconds.length < IMAGE_SPEED_MIN_SAMPLES) continue;
        const sorted = [...seconds].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        typical[modelId] =
            sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return typical;
};

/** Enabled models with at least one square price, in catalogue order. */
export const chatImageModelCandidates = (
    models: readonly Pick<
        ImageModelProfile,
        "id" | "name" | "latencyClass" | "prices" | "disabledReason" | "routingNote"
    >[],
    /** Measured typical seconds per model id (typicalImageSeconds); absent models show their band alone. */
    typicalSeconds: Readonly<Record<string, number>> = {}
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
        const note = model.routingNote?.trim();
        const seconds = Object.hasOwn(typicalSeconds, model.id) ? typicalSeconds[model.id] : undefined;
        return [
            {
                id: model.id,
                name: model.name,
                latency: model.latencyClass,
                ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
                    ? { seconds: Math.round(seconds) || 1 }
                    : {}),
                credits,
                ...(note ? { note } : {}),
            },
        ];
    });

export const CHAT_IMAGE_ROUTING_CRITERIA = [
    "image=true when the user wants a picture made: draw, paint, generate, render or illustrate a photo, illustration, artwork, logo, poster, wallpaper, character, scene or similar visual, in any language.",
    "image=false for everything else, including:",
    "- questions about images or about how image generation works;",
    "- describing or analysing an attached or existing image;",
    "- editing an attached image, unless an \"Attached photo\" section says it can be edited;",
    "- code or text that produces graphics (SVG, HTML/CSS, charts, plots, diagrams, ASCII art);",
    "- writing a prompt for another image tool;",
    "- messages that only mention a picture in passing.",
    "When unsure, answer image=false.",
    "",
    "When image=true, choose the model by fit first, speed second and price third:",
    "- read what the request needs (legible text and its language, photorealism or people, an illustration or anime style, a logo or icon, a dense layout, editing a photo) and compare it with each model's note;",
    "- pick the model whose note fits the request best, and avoid a model whose note names the request's main need as a weakness;",
    "- between models that fit about equally, pick the clearly faster one: compare the typical seconds where a model lists them, otherwise its speed band (fast, balanced, slow). The user is waiting in a chat, so a much slower model is worth its wait only when its note fits the request's main need clearly better;",
    "- when the user asks for a quick result, speed is the request's main need;",
    "- only between models that fit about equally and take about as long, pick the one with fewer credits; a model without a note is known by its name alone and is never preferred for being faster or cheaper;",
    "- when the request states no particular need, every model fits equally: the faster wins, then the cheaper.",
    "Then choose the preset:",
    "- standard: the default for ordinary image requests, including posters, legible text, several subjects and photorealistic scenes; complexity or the image's intended use alone does not upgrade the preset;",
    "- draft: only when the user requests a rough sketch, draft, faster generation or lower cost;",
    "- final: only when the user explicitly requests high quality, best quality or a higher-quality regeneration of a previous image.",
    "Use only a preset the chosen model lists.",
].join("\n");

export const buildChatImageIntentSystem = (options: {
    combined?: boolean;
    followUp?: boolean;
    attachedPhoto?: boolean;
    /**
     * The routing criteria in force: a promoted image cycle's
     * (lib/imageRoutingOptimizer.ts), or CHAT_IMAGE_ROUTING_CRITERIA.
     */
    criteria?: string;
} = {}) => [
    "You route messages sent to a chat assistant that cannot draw.",
    "A separate image generator exists. Decide whether this message asks for a new image to be created and, if it does, which image model and preset should make it.",
    "",
    (options.criteria ?? CHAT_IMAGE_ROUTING_CRITERIA).trim(),
    "",
    options.followUp === false ? "No previous image is available. Set prompt to an empty string." :
        "A \"Previous image\" section, when present, is the prompt that made the last image in this conversation. A message that asks to change, redo or vary that image -- its colour, style, subject, details, composition or quality, e.g. \"make it bluer\", \"now as a watercolour\", \"add a hat\", \"regenerate this image in high quality\" -- is image=true: a new image is made from a new prompt. Then write prompt: the complete prompt for the new image, the previous prompt with the change applied, in the previous prompt's language, at most 1500 characters -- shorten the unchanged parts if needed, never the change. In every other case prompt is an empty string.",
    options.attachedPhoto === false ? "No editable photo is attached. Set edit to false." :
        "An \"Attached photo\" section, when present, means the user sent a photo with this message and the listed models can edit it. A message that asks to change that photo -- resize, move, remove, add or recolour something in it, change its style or background, while keeping the rest -- is image=true and edit=true; the message itself is the edit instruction, so prompt is an empty string. A question about the photo, or a request to describe, analyse, translate or read it, is image=false. Without that section edit is always false.",
    options.combined
        ? "Return imageIntent=null when image=false; do not choose unused image fields. When image=true return the imageIntent object. These image rules apply only to imageIntent, not the chat modelId or rewrite."
        : "When image=false, fill modelId and preset with any listed value; they are ignored.",
].join("\n");

export const CHAT_IMAGE_INTENT_SYSTEM = buildChatImageIntentSystem();

/** The message the model sees: trimmed and capped. Empty means no call. */
export const chatImageIntentPrompt = (text: string): string =>
    text.trim().slice(0, CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS);

/** The model list, the previous image when there is one, then the message. */
export const chatImageIntentUserMessage = (
    text: string,
    candidates: readonly ChatImageModelCandidate[],
    previousImagePrompt: string | null = null,
    /** The message carries a photo the listed models can edit. */
    attachedPhoto = false,
    /** Combined routing shares the exact same message from its JSON input. */
    sharedMessage = false
): string =>
    [
        "Image models (credits per 1024x1024 image, by preset; then the model's note):",
        ...candidates.map((candidate) => {
            const prices = PRESETS.filter((preset) => candidate.credits[preset] !== undefined)
                .map((preset) => `${preset} ${candidate.credits[preset]}`)
                .join(", ");
            const speed =
                candidate.seconds === undefined
                    ? candidate.latency
                    : `${candidate.latency}, typically ${candidate.seconds}s`;
            const line = `- ${candidate.id} (${candidate.name}; ${speed}): ${prices}`;
            return candidate.note ? `${line} -- ${candidate.note}` : line;
        }),
        "",
        ...(previousImagePrompt
            ? [
                  "Previous image:",
                  // Whole: a cut previous prompt would lose what the change
                  // is applied to.
                  previousImagePrompt,
                  "",
              ]
            : []),
        ...(attachedPhoto
            ? ["Attached photo:", "The user attached a photo to this message.", ""]
            : []),
        ...(sharedMessage ? ["Message: use the message field in the routing JSON above."] : ["Message:", chatImageIntentPrompt(text)]),
    ].join("\n");

export const chatImageIntentOutputSchema = (
    candidates: readonly ChatImageModelCandidate[]
) => ({
    type: "object" as const,
    properties: {
        image: { type: "boolean" as const },
        modelId: { type: "string" as const, enum: candidates.map((candidate) => candidate.id) },
        preset: { type: "string" as const, enum: [...PRESETS] },
        prompt: { type: "string" as const },
        edit: { type: "boolean" as const },
    },
    required: ["image", "modelId", "preset", "prompt", "edit"],
    additionalProperties: false as const,
});

/**
 * Only an explicit `image: true` routes. A model or preset outside the list --
 * or a preset the chosen model does not offer -- is dropped rather than
 * trusted, and the workspace keeps its own default for it.
 */
export const parseChatImageIntentOutput = (
    output: unknown,
    candidates: readonly ChatImageModelCandidate[],
    /** A rewrite is kept only when the call was shown a previous image. */
    followUpAllowed = false,
    /**
     * The call was told a photo is attached. Then only an edit routes: a
     * message sent with a photo that is not about changing it is answered by
     * chat, which can see the photo.
     */
    attachedPhoto = false
): ChatImageDecision => {
    if (typeof output !== "object" || output === null) return { image: false };
    const value = output as {
        image?: unknown;
        modelId?: unknown;
        preset?: unknown;
        prompt?: unknown;
        edit?: unknown;
    };
    if (value.image !== true) return { image: false };
    const edit = attachedPhoto && value.edit === true;
    if (attachedPhoto && !edit) return { image: false };
    if (edit) {
        const candidate = candidates.find((entry) => entry.id === value.modelId);
        const preset =
            candidate &&
            typeof value.preset === "string" &&
            (PRESETS as readonly string[]).includes(value.preset) &&
            candidate.credits[value.preset as ImagePreset] !== undefined
                ? (value.preset as ImagePreset)
                : null;
        // The message is the instruction; a rewrite is never taken for an edit.
        return { image: true, modelId: candidate?.id ?? null, preset, prompt: null, edit: true };
    }
    const rewrite =
        followUpAllowed && typeof value.prompt === "string" ? value.prompt.trim() : "";
    // Over the limit is refused, not cut: see CHAT_IMAGE_INTENT_MAX_REWRITE_CHARS.
    // The message then goes to chat rather than paying for a mangled image.
    if (rewrite.length > CHAT_IMAGE_INTENT_MAX_REWRITE_CHARS) return { image: false };
    const prompt = rewrite || null;
    const candidate = candidates.find((entry) => entry.id === value.modelId);
    if (!candidate) return { image: true, modelId: null, preset: null, prompt, edit: false };
    const preset =
        typeof value.preset === "string" &&
        (PRESETS as readonly string[]).includes(value.preset) &&
        candidate.credits[value.preset as ImagePreset] !== undefined
            ? (value.preset as ImagePreset)
            : null;
    return { image: true, modelId: candidate.id, preset, prompt, edit: false };
};

/** The client's reading of the route's JSON; anything malformed is chat. */
export const readChatImageDecision = (data: unknown): ChatImageDecision => {
    if (typeof data !== "object" || data === null) return { image: false };
    const value = data as {
        image?: unknown;
        modelId?: unknown;
        preset?: unknown;
        prompt?: unknown;
    };
    if (value.image !== true) return { image: false };
    if (
        typeof value.prompt === "string" &&
        value.prompt.trim().length > CHAT_IMAGE_INTENT_MAX_REWRITE_CHARS
    ) {
        return { image: false };
    }
    return {
        image: true,
        modelId: typeof value.modelId === "string" && value.modelId ? value.modelId : null,
        preset:
            typeof value.preset === "string" &&
            (PRESETS as readonly string[]).includes(value.preset)
                ? (value.preset as ImagePreset)
                : null,
        prompt:
            typeof value.prompt === "string" && value.prompt.trim()
                ? value.prompt.trim()
                : null,
        edit: (value as { edit?: unknown }).edit === true,
        ...(typeof (value as { routingDecisionId?: unknown }).routingDecisionId === "string" &&
        /^[a-z0-9]{20,40}$/.test((value as { routingDecisionId: string }).routingDecisionId)
            ? { routingDecisionId: (value as { routingDecisionId: string }).routingDecisionId }
            : {}),
    };
};

/**
 * Whether the message being sent carries a photo an edit could start from,
 * by the type the request declares. Only an eligibility hint for asking the
 * image-intent call: the image turn finds the photo from the saved message
 * and refuses the edit when there is none.
 */
export const latestUserTurnHasImageAttachment = (
    messages: readonly { role?: unknown; attachments?: unknown }[]
): boolean => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user") continue;
        return (
            Array.isArray(message.attachments) &&
            message.attachments.some(
                (attachment) =>
                    typeof attachment === "object" &&
                    attachment !== null &&
                    IMAGE_EDIT_SOURCE_MEDIA_TYPES.includes(
                        String((attachment as { mediaType?: unknown }).mediaType ?? "").toLowerCase()
                    )
            )
        );
    }
    return false;
};

/**
 * Whether the message being sent -- the last user message -- carries an
 * attachment. Only that turn decides image eligibility: a file shared earlier
 * in the conversation does not make a later "draw a cat" anything but an
 * image request.
 */
export const latestUserTurnHasAttachments = (
    messages: readonly { role?: unknown; attachments?: unknown }[]
): boolean => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user") continue;
        return Array.isArray(message.attachments) && message.attachments.length > 0;
    }
    return false;
};
