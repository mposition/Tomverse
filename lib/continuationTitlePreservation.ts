/**
 * Keeping a continuation's shown name when its source is deleted.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3, §6.1 (the
 * reserved title and keeping a name on delete, CONT-TITLE-01 decisions D1, D3).
 *
 * An unnamed continuation shows its source's title without storing it
 * (lib/continuationDisplayTitle.ts), so deleting the source changes the name.
 * The delete confirmation says so, and offers -- off by default -- to save
 * that title as the conversation's own name in the same transaction as the
 * delete. Saving it is the owner's explicit choice to copy the source's words
 * into a table the deletion does not reach, which is why it is never
 * automatic.
 *
 * Pure: the preview, the delete transaction and the tests share these rules.
 */

import { LEGACY_CONTINUATION_TITLE } from "@/lib/continuationDisplayTitle";
import { CONVERSATION_TITLE_MAX_LENGTH } from "@/lib/conversationRename";

/**
 * D1: a continuation cannot be renamed to the writer's placeholder.
 *
 * The placeholder is how a stored title says "nobody has named this", and that
 * is judged by equality with the string alone. A continuation its owner named
 * exactly that would read as unnamed forever after. Only continuations: for
 * a conversation without a bridge the string means nothing and stays allowed.
 * Rows that already hold it are left alone; nothing distinguishes them.
 */
export function isReservedContinuationTitle({
    title,
    isContinuation,
}: {
    title: string;
    isContinuation: boolean;
}): boolean {
    return isContinuation && title.trim() === LEGACY_CONTINUATION_TITLE;
}

/** The error code for a delete refused because a confirmed choice went stale. */
export const SOURCE_TITLE_PRESERVATION_STALE = "SOURCE_TITLE_PRESERVATION_STALE";

/** The error code for a delete that asked to keep more names than one request carries. */
export const SOURCE_TITLE_PRESERVATION_TOO_MANY = "SOURCE_TITLE_PRESERVATION_TOO_MANY";

/** The query parameter carrying the continuation ids whose names to keep. */
export const PRESERVE_TITLES_PARAM = "preserveTitles";
/**
 * The most names one delete keeps. A request over it is refused, never cut:
 * silently keeping the first hundred would delete the source and change the
 * other names the owner chose to keep. The confirmation does not offer keeping
 * when more than this many could be kept.
 */
export const MAX_PRESERVE_TITLE_IDS = 100;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The ids a delete request asked to keep names for. Malformed entries are
 * dropped rather than refused: an id is only ever consent for itself, and the
 * server still decides each one against the row. More distinct ids than the
 * limit is reported, so the route refuses before deleting anything.
 */
export function readTitlePreservationRequest(url: URL): {
    ids: string[];
    tooMany: boolean;
} {
    const ids = [
        ...new Set(
            url.searchParams
                .getAll(PRESERVE_TITLES_PARAM)
                .flatMap((value) => value.split(","))
                .map((value) => value.trim())
                .filter((value) => CONVERSATION_ID.test(value))
        ),
    ];
    return ids.length > MAX_PRESERVE_TITLE_IDS
        ? { ids: [], tooMany: true }
        : { ids, tooMany: false };
}

/** `?include=titleImpact` -- opt-in, like `memoryImpact`. */
export function wantsTitleImpact(url: URL): boolean {
    return url.searchParams
        .getAll("include")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .includes("titleImpact");
}

/** One continuation of a source about to be deleted. */
export type TitlePreservationTarget = {
    conversationId: string;
    /** `Conversation.title` as stored. */
    conversationTitle: string;
    /** The continuation's own lock. */
    conversationLocked: boolean;
    /** The source's title as stored; never sent to a client by this module. */
    sourceTitle: string | null;
    sourceLocked: boolean;
};

export type TitlePreservability =
    | "preservable"
    /** Already named: nothing will change, nothing to keep. */
    | "named"
    /**
     * The source is locked or has no title, so the row already shows its
     * fallback name -- and shows the same one after the delete.
     */
    | "already_fallback"
    /** The name changes, but the continuation is locked. */
    | "conversation_locked"
    /** The name changes, but the placeholder itself or longer than a title may be. */
    | "source_title_unusable";

export function titlePreservability(target: TitlePreservationTarget): TitlePreservability {
    if (target.conversationTitle !== LEGACY_CONTINUATION_TITLE) return "named";
    const title = target.sourceTitle?.trim() ?? "";
    // What the list shows today (lib/continuationTitleContext.ts): the source's
    // title only when it is readable and non-empty.
    if (target.sourceLocked || !title) return "already_fallback";
    if (target.conversationLocked) return "conversation_locked";
    if (
        isReservedContinuationTitle({ title, isContinuation: true }) ||
        title.length > CONVERSATION_TITLE_MAX_LENGTH
    ) {
        return "source_title_unusable";
    }
    return "preservable";
}

/**
 * What the confirmation states: how many shown names this delete changes, and
 * which of those can be kept. Counts and the owner's own conversation ids --
 * never a title. A row whose source is locked or untitled already shows its
 * fallback and is not counted: deleting the source does not change its name.
 * The two numbers differ when a continuation is locked or the source's title
 * cannot be a conversation title.
 */
export type TitleImpact = {
    changingCount: number;
    preservableConversationIds: string[];
};

export function summarizeTitleImpact(targets: readonly TitlePreservationTarget[]): TitleImpact {
    let changingCount = 0;
    const preservableConversationIds: string[] = [];
    for (const target of targets) {
        const state = titlePreservability(target);
        if (state === "named" || state === "already_fallback") continue;
        changingCount += 1;
        if (state === "preservable") preservableConversationIds.push(target.conversationId);
    }
    preservableConversationIds.sort();
    return { changingCount, preservableConversationIds };
}

export type TitlePreservationJudgement =
    | { kind: "accepted"; writes: { conversationId: string; title: string }[] }
    | {
          kind: "refused";
          /**
           * Something the owner confirmed against changed before the delete:
           * a lock was set, or the source's title stopped being usable.
           */
          reason: "stale";
      };

/**
 * Every requested id judged before anything is written.
 *
 * - Not a continuation of what is being deleted (or not the owner's, or gone):
 *   skipped. The request is consent only for the intersection.
 * - Already named, e.g. renamed in another window after the confirmation:
 *   skipped, and the owner's name stays. Not an error.
 * - Locked, or the source title no longer usable: the whole delete is refused,
 *   so a choice the owner made is never silently dropped.
 */
export function judgeTitlePreservation(
    requestedIds: readonly string[],
    targets: readonly TitlePreservationTarget[]
): TitlePreservationJudgement {
    const byId = new Map(targets.map((target) => [target.conversationId, target]));
    const writes: { conversationId: string; title: string }[] = [];
    for (const conversationId of [...new Set(requestedIds)].sort()) {
        const target = byId.get(conversationId);
        if (!target) continue;
        const state = titlePreservability(target);
        if (state === "named") continue;
        if (state !== "preservable") return { kind: "refused", reason: "stale" };
        writes.push({ conversationId, title: target.sourceTitle!.trim() });
    }
    return { kind: "accepted", writes };
}
