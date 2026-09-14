import type { SourceDeletionDisposition } from "@/lib/memorySourceDeletion";
import {
    PRESERVE_TITLES_PARAM,
    SOURCE_TITLE_PRESERVATION_STALE,
} from "@/lib/continuationTitlePreservation";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * How a delete request carries the §13.1 memory choice.
 *
 * Query parameters rather than a body: these are DELETE requests, and the
 * choice is a small closed enum. Anything unrecognized falls back to the
 * policy default rather than being rejected — a client that sends nothing,
 * or sends nonsense, gets the behaviour §13.1 specifies, which is the safe
 * one for derived memories and the conservative one for edited ones.
 *
 * Shared by both source-delete routes so the two cannot drift into meaning
 * different things by the same parameter name.
 */

export const DERIVED_MEMORY_PARAM = "derivedMemories";
export const EDITED_MEMORY_PARAM = "editedMemories";

const asDisposition = (
    value: string | null
): SourceDeletionDisposition | undefined =>
    value === "delete" || value === "suspend" ? value : undefined;

export function readSourceDeletionDispositions(url: URL): {
    derived?: SourceDeletionDisposition;
    userTouched?: SourceDeletionDisposition;
} {
    return {
        derived: asDisposition(url.searchParams.get(DERIVED_MEMORY_PARAM)),
        userTouched: asDisposition(url.searchParams.get(EDITED_MEMORY_PARAM)),
    };
}

/** `?include=memoryImpact` — opt-in, so an ordinary read costs nothing extra. */
export function wantsMemoryImpact(url: URL): boolean {
    return url.searchParams
        .getAll("include")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .includes("memoryImpact");
}

/**
 * The query string both delete confirmations send: the memory choice
 * (docs/policy/external-conversation-import-and-memory.md §13.1),
 * and the continuations whose shown names the owner chose to keep
 * (lib/continuationTitlePreservation.ts). Built in one place so the list and
 * the viewer send the same thing.
 */
export function sourceDeletionQuery({
    keepMemories,
    preserveTitleConversationIds,
}: {
    keepMemories: boolean;
    preserveTitleConversationIds: readonly string[];
}): string {
    const params = new URLSearchParams();
    params.set(DERIVED_MEMORY_PARAM, keepMemories ? "suspend" : "delete");
    if (preserveTitleConversationIds.length > 0) {
        params.set(PRESERVE_TITLES_PARAM, preserveTitleConversationIds.join(","));
    }
    return params.toString();
}

/**
 * Whether a delete was refused because something the owner confirmed against
 * changed -- nothing was deleted, and the confirmation should be shown again.
 * Consumes the body either way.
 */
export async function isStaleTitlePreservation(response: Response): Promise<boolean> {
    if (response.status !== 409) {
        await discardResponseBody(response);
        return false;
    }
    const code = await response
        .json()
        .then((body: { code?: unknown }) => body?.code)
        .catch(() => undefined);
    return code === SOURCE_TITLE_PRESERVATION_STALE;
}
