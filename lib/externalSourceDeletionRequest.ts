import type { SourceDeletionDisposition } from "@/lib/memorySourceDeletion";

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
