/**
 * Client-safe pieces of a Tomverse Chat image turn (lib/chatImageTurn.ts).
 */

/**
 * How the stored answer text of an image turn begins. The image itself is
 * shown from the group; this text is what later turns, shares and exports
 * read, so it says plainly that an image was made and for what.
 */
export const CHAT_IMAGE_TURN_CONTENT_PREFIX = "[Image generated]";

/**
 * What a transcript message carries when it is answered by an image group:
 * the group its card polls, and the image models that make it -- which is
 * what the answer's header names, not the panel's chat model.
 */
export type ChatImageTurnRef = { groupId: string; modelIds: string[] };

/** The client's reading of a message's `imageTurn`; anything else is none. */
export const readChatImageTurnRef = (value: unknown): ChatImageTurnRef | null => {
    if (typeof value !== "object" || value === null) return null;
    const { groupId, modelIds } = value as { groupId?: unknown; modelIds?: unknown };
    if (typeof groupId !== "string" || !groupId) return null;
    return {
        groupId,
        modelIds: Array.isArray(modelIds)
            ? modelIds.filter((id): id is string => typeof id === "string" && id !== "")
            : [],
    };
};

/** What the send asks the image turn for: the image-intent triage's choice. */
export type ChatImageTurnRequest = {
    modelIds: string[];
    preset: "draft" | "standard" | "final" | null;
    /**
     * A follow-up's rewritten prompt (the previous image with the change
     * applied). Absent means the saved question is the prompt.
     */
    prompt?: string;
    /** Change the photo attached to the question instead of drawing anew. */
    edit?: true;
    /**
     * Set on a retry only: the answer id the first try used, which is also
     * the image group's idempotency key, so the retry recovers that group
     * instead of reserving a second one.
     */
    assistantMessageId?: string;
    /**
     * Review panels share one priced image group, with distinct answer ids.
     * `panelModelIds` is each panel's chat model in `modelIds` order, so the
     * request that reserves the group writes every panel's answer.
     */
    comparison?: { id: string; index: number; modelIds: string[]; panelModelIds?: string[] };
    /** The routing decision this turn answers, linked to its group by the server. */
    routingDecisionId?: string;
};

export const chatImageTurnGroupKey = (answerId: string) =>
    /^[0-9a-f-]{36}_[0-9]+$/.test(answerId) ? answerId.slice(0, answerId.lastIndexOf("_")) : answerId;

const TURN_PRESETS = ["draft", "standard", "final"] as const;

/**
 * The client's reading of an image decision /api/chat answered with
 * (`X-Chat-Response-Mode: image-turn`). Null when it is not one; the turn then
 * fails rather than guessing.
 */
export const readChatImageTurnRequest = (value: unknown): ChatImageTurnRequest | null => {
    if (typeof value !== "object" || value === null) return null;
    const { modelIds, preset, prompt, edit, routingDecisionId } = value as {
        modelIds?: unknown;
        preset?: unknown;
        prompt?: unknown;
        edit?: unknown;
        routingDecisionId?: unknown;
    };
    if (!Array.isArray(modelIds)) return null;
    return {
        modelIds: modelIds.filter((id): id is string => typeof id === "string" && id !== ""),
        preset:
            typeof preset === "string" && (TURN_PRESETS as readonly string[]).includes(preset)
                ? (preset as ChatImageTurnRequest["preset"])
                : null,
        ...(typeof prompt === "string" && prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(edit === true ? { edit: true as const } : {}),
        ...(typeof routingDecisionId === "string" && /^[a-z0-9]{20,40}$/.test(routingDecisionId) ? { routingDecisionId } : {}),
    };
};

/**
 * Why a photo cannot be edited, known before anything is reserved. Raised with
 * these codes so the panel can say which: the photo is larger than an edit
 * accepts, or it is a file the editor cannot decode. Neither costs credits.
 */
export const IMAGE_EDIT_SOURCE_TOO_LARGE = "IMAGE_EDIT_SOURCE_TOO_LARGE";
export const IMAGE_EDIT_SOURCE_UNSUPPORTED = "IMAGE_EDIT_SOURCE_UNSUPPORTED";

export type ImageEditSourceRefusalCode =
    | typeof IMAGE_EDIT_SOURCE_TOO_LARGE
    | typeof IMAGE_EDIT_SOURCE_UNSUPPORTED;

export const imageEditSourceRefusalCode = (value: unknown): ImageEditSourceRefusalCode | null =>
    value === IMAGE_EDIT_SOURCE_TOO_LARGE || value === IMAGE_EDIT_SOURCE_UNSUPPORTED ? value : null;

/** When a refused Review panel looks for its answer again: right away, then backing off (~15 s in all). */
export const REVIEW_PANEL_ANSWER_READ_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

/**
 * A Review panel whose own image-turn POST the image allowance refused (429)
 * may still have a paid image: the panel that reserved the group wrote every
 * panel's answer in the same transaction (lib/chatImageTurn.ts). This reads
 * that saved answer (GET .../image-turn), waiting a little for the reserving
 * request to commit. Null when no answer appears -- nothing was reserved, and
 * the refusal stands. Reads only: it never sends the turn again.
 */
export async function readRefusedReviewPanelAnswer(input: {
    conversationId: string;
    assistantMessageId: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    delaysMs?: readonly number[];
}): Promise<{ content: string; imageTurn: ChatImageTurnRef } | null> {
    const request = input.fetch ?? fetch;
    const query = new URLSearchParams({ assistantMessageId: input.assistantMessageId });
    const url = `/api/conversations/${encodeURIComponent(input.conversationId)}/image-turn?${query}`;
    for (const delay of input.delaysMs ?? REVIEW_PANEL_ANSWER_READ_DELAYS_MS) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (input.signal?.aborted) return null;
        try {
            const res = await request(url, { method: "GET", signal: input.signal });
            const body = (await res.json().catch(() => null)) as { content?: unknown; imageTurn?: unknown } | null;
            const imageTurn = res.ok ? readChatImageTurnRef(body?.imageTurn) : null;
            if (imageTurn) return { content: typeof body?.content === "string" ? body.content : "", imageTurn };
            // Not there yet (404) or a transient failure: wait and read again.
            // Any other refusal (locked, signed out) will not change.
            if (res.status !== 404 && res.status < 500) return null;
        } catch {
            if (input.signal?.aborted) return null;
        }
    }
    return null;
}
