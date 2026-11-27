import "server-only";

import { createHash } from "node:crypto";

import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import {
    buildPersonalizationPrompt,
    PERSONALIZATION_PROMPT_VERSION,
    personalizationFromRow,
    type UserPersonalizationValue,
} from "@/lib/chatPersonalizationCore";
import { prisma } from "@/lib/prisma";

/** What the turn context builder adds for one account (lib/chatTurnContext.ts). */
export type PersonalizationTurnBlock = {
    prompt: string | null;
    /** Input tokens the block adds, priced with the rest of the context block. */
    tokens: number;
    /** Bound into the context bundle; `"none"` when nothing is sent. */
    hash: string;
};

export const NO_PERSONALIZATION_BLOCK: PersonalizationTurnBlock = { prompt: null, tokens: 0, hash: "none" };

/**
 * The rendered block's digest and the prompt version, so an edit between
 * preparation and send, or a new rendering, makes the bundle stale rather
 * than sending text nobody priced.
 */
export function personalizationHash(prompt: string | null): string {
    if (prompt === null) return "none";
    return `${PERSONALIZATION_PROMPT_VERSION}:${createHash("sha256").update(prompt, "utf8").digest("base64url")}`;
}

export async function readUserPersonalization(userId: string): Promise<UserPersonalizationValue> {
    const row = await prisma.userPersonalization.findUnique({
        where: { userId },
        select: { aboutMe: true, responsePreferences: true, responseStyle: true },
    });
    return personalizationFromRow(row);
}

export async function saveUserPersonalization(
    userId: string,
    value: UserPersonalizationValue
): Promise<UserPersonalizationValue> {
    const row = await prisma.userPersonalization.upsert({
        where: { userId },
        create: { userId, ...value },
        update: value,
        select: { aboutMe: true, responsePreferences: true, responseStyle: true },
    });
    return personalizationFromRow(row);
}

/** The block a signed-in turn carries. A guest has none. */
export async function readPersonalizationTurnBlock(userId: string | null): Promise<PersonalizationTurnBlock> {
    if (!userId) return NO_PERSONALIZATION_BLOCK;
    const prompt = buildPersonalizationPrompt(await readUserPersonalization(userId));
    if (prompt === null) return NO_PERSONALIZATION_BLOCK;
    return { prompt, tokens: estimatePromptTokens(prompt), hash: personalizationHash(prompt) };
}
