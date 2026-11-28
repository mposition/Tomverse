import { z } from "zod";

/**
 * Saved prompts: text an account keeps under a name and puts back into the
 * composer. Pure: the routes validate with these schemas, and the composer's
 * picker uses the same limits so it can stop at them before the server has to.
 *
 * The same for every plan. Signed-in accounts only: a guest has no account for
 * the prompts to belong to.
 */
export const SAVED_PROMPT_LIMITS = {
    /** Prompts one account may keep. */
    count: 100,
    titleMax: 80,
    bodyMax: 10_000,
} as const;

const title = z.string().trim().min(1).max(SAVED_PROMPT_LIMITS.titleMax);
// Not trimmed: leading indentation and trailing blank lines can be the prompt.
const body = z
    .string()
    .max(SAVED_PROMPT_LIMITS.bodyMax)
    .refine((value) => value.trim().length > 0, "A prompt needs some text.");

export const savedPromptCreateSchema = z.object({ title, body }).strict();
export const savedPromptUpdateSchema = z
    .object({ title: title.optional(), body: body.optional() })
    .strict()
    .refine((value) => value.title !== undefined || value.body !== undefined, "Nothing to change.");

export type SavedPrompt = {
    id: string;
    title: string;
    body: string;
    updatedAt: string;
};

/** A name for a prompt saved straight from the composer: its first line, cut short. */
export const suggestedSavedPromptTitle = (text: string): string => {
    const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
    const clipped = firstLine.length > 40 ? `${firstLine.slice(0, 39).trimEnd()}…` : firstLine;
    return clipped.slice(0, SAVED_PROMPT_LIMITS.titleMax);
};

/** What the composer holds after a saved prompt is put in: never a lost draft. */
export const composerTextWithSavedPrompt = (current: string, prompt: string): string =>
    current.trim().length === 0 ? prompt : `${current.replace(/\s+$/u, "")}\n\n${prompt}`;
