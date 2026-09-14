/**
 * Keeping a continuation's shown name when its source is deleted.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3, §6.
 * Decisions: .github/audits/tomverse-product-idea-backlog.md, CONT-TITLE-01
 * "확정 구현 기준" (D1, D3).
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

/** The query parameter carrying the continuation ids whose names to keep. */
export const PRESERVE_TITLES_PARAM = "preserveTitles";
const MAX_PRESERVE_TITLE_IDS = 100;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The ids a delete request asked to keep names for. Malformed entries are
 * dropped rather than refused: an id is only ever consent for itself, and the
 * server still decides each one against the row.
 */
export function readTitlePreservationRequest(url: URL): string[] {
    const ids = url.searchParams
        .getAll(PRESERVE_TITLES_PARAM)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter((value) => CONVERSATION_ID.test(value));
    return [...new Set(ids)].slice(0, MAX_PRESERVE_TITLE_IDS);
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
    | "conversation_locked"
    | "source_locked"
    /** Empty, the placeholder itself, or longer than a title may be. */
    | "source_title_unusable";

export function titlePreservability(target: TitlePreservationTarget): TitlePreservability {
    if (target.conversationTitle !== LEGACY_CONTINUATION_TITLE) return "named";
    if (target.conversationLocked) return "conversation_locked";
    if (target.sourceLocked) return "source_locked";
    const title = target.sourceTitle?.trim() ?? "";
    if (
        !title ||
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
 * never a title. The two numbers differ whenever a source is locked, untitled,
 * or its continuation is locked.
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
        if (state === "named") continue;
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
