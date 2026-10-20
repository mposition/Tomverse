/**
 * The pure half of the chat image-intent call (lib/chatImageIntent.ts): one
 * small model call that answers "is this chat message a request to create an
 * image?", so a chat send can go straight to the image workspace instead of
 * an answer explaining that chat cannot draw.
 *
 * Off unless `CHAT_IMAGE_INTENT_MODEL_ID` names an enabled chat model. The
 * call only routes; the image workspace still quotes the price and spends
 * credits under its own consent rules (docs/policy/image-generation.md).
 */

/** Long enough to read the request; the rest of a long message adds nothing. */
export const CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS = 2_000;

/** `{"image":true}` plus slack for providers that count reasoning as output. */
export const CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS = 64;

/** The send waits on this call, so a slow answer reads as "not an image". */
export const CHAT_IMAGE_INTENT_TIMEOUT_MS = 4_000;

/** The composer's wait: the server's deadline plus the round trip. */
export const CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS = 5_000;

/** The configured model id, or null when the feature is off. */
export const chatImageIntentModelId = (
    env: Record<string, string | undefined> = process.env
): string | null => {
    const value = env.CHAT_IMAGE_INTENT_MODEL_ID?.trim();
    return value ? value : null;
};

export const CHAT_IMAGE_INTENT_SYSTEM = [
    "You route messages sent to a chat assistant that cannot draw.",
    "A separate image generator exists. Decide whether this message asks for a new image to be created.",
    "",
    "image=true when the user wants a picture made: draw, paint, generate, render or illustrate a photo, illustration, artwork, logo, poster, wallpaper, character, scene or similar visual, in any language.",
    "image=false for everything else, including:",
    "- questions about images or about how image generation works;",
    "- describing, analysing or editing an attached or existing image;",
    "- code or text that produces graphics (SVG, HTML/CSS, charts, plots, diagrams, ASCII art);",
    "- writing a prompt for another image tool;",
    "- messages that only mention a picture in passing.",
    "When unsure, answer image=false.",
].join("\n");

export const chatImageIntentOutputSchema = () => ({
    type: "object" as const,
    properties: { image: { type: "boolean" as const } },
    required: ["image"],
    additionalProperties: false as const,
});

/** True only for an explicit `image: true`; anything malformed is chat. */
export const parseChatImageIntentOutput = (output: unknown): boolean =>
    typeof output === "object" &&
    output !== null &&
    (output as { image?: unknown }).image === true;

/** The message the model sees: trimmed and capped. Empty means no call. */
export const chatImageIntentPrompt = (text: string): string =>
    text.trim().slice(0, CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS);
