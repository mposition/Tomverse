// Resolving a moving alias to the concrete model behind it.
//
// ## Why this exists
//
// Wave 1 was drafted against `mistral-large-latest`, and the drafting script
// recorded the version from the completion response's `model` field on the
// stated principle that an echo of the request would "look like a record
// while recording nothing". Mistral returns the alias verbatim in that field,
// so the record read:
//
//     requestedApiModel: "mistral-large-latest"
//     modelVersion:      "mistral-large-latest"
//
// which is precisely the echo the principle was written to exclude. The
// review sheet then told the reviewer to compare that field across the ko and
// en batches of a wave -- a comparison that always matches and proves
// nothing, which is worse than no check at all.
//
// The provider's model listing does carry the mapping. Asked for the models
// it serves, Mistral returns both directions of it:
//
//     { id: "mistral-large-2512",   aliases: ["mistral-large-latest"] }
//     { id: "mistral-large-latest", name: "mistral-large-2512",
//       aliases: ["mistral-large-2512"] }
//
// so `mistral-large-latest` can be pinned to `mistral-large-2512` at a stated
// moment. That is what the ko/en comparison needs.
//
// ## What it will not do
//
// It never returns the requested id as its own resolution. "The listing had
// no alias for it" and "it resolves to itself" are different claims, and only
// the first one is supported by a listing that says nothing. Nor does it pick
// between conflicting candidates: two concrete ids behind one alias is a
// finding for a person, not a coin toss.

/** One entry of a provider's `GET /models` listing. Shapes differ by provider, so nothing is assumed. */
export type ModelListEntry = {
    id?: unknown;
    name?: unknown;
    aliases?: unknown;
};

export type AliasResolutionOutcome =
    /** The listing named exactly one concrete model behind the requested id. */
    | "resolved"
    /** The listing has the id but records no other name for it. Not a claim that it is stable. */
    | "no-alias-recorded"
    /** More than one distinct concrete id claims to be behind it. Left for a person. */
    | "ambiguous"
    /** The listing does not contain the requested id at all. */
    | "not-listed"
    /** The listing could not be read. Set by the caller, never by the resolver. */
    | "unavailable";

export type AliasResolution = {
    resolvedModelId: string | null;
    outcome: AliasResolutionOutcome;
    /** Every distinct concrete candidate found, so an `ambiguous` result can be read. */
    candidates: string[];
};

/**
 * Names that are themselves pointers rather than versions. A pointer behind a
 * pointer resolves nothing, so these are never accepted as a resolution.
 */
const isMovingAlias = (name: string): boolean => /(^|[-_/])latest$/.test(name);

const asName = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * The listing arrives as parsed JSON from a provider, so a null or a number
 * where an object was expected is a shape the caller can actually receive.
 */
const asEntry = (value: unknown): ModelListEntry | null =>
    typeof value === "object" && value !== null ? (value as ModelListEntry) : null;

const aliasesOf = (entry: ModelListEntry): string[] =>
    Array.isArray(entry.aliases) ? entry.aliases.map(asName).filter((n): n is string => n !== null) : [];

/**
 * Pin `requestedModelId` to the concrete model the provider's listing puts
 * behind it.
 *
 * Both directions of the mapping are read: the requested entry's own `name`
 * and `aliases`, and any other entry that claims the requested id as one of
 * its aliases. They should agree; when they do not, the result is `ambiguous`
 * rather than whichever came first.
 */
export const resolveModelAlias = (
    entries: readonly ModelListEntry[],
    requestedModelId: string
): AliasResolution => {
    const requested = asName(requestedModelId);
    if (!requested) return { resolvedModelId: null, outcome: "not-listed", candidates: [] };

    const listed = entries.map(asEntry).filter((entry): entry is ModelListEntry => entry !== null);
    const own = listed.find((entry) => asName(entry.id) === requested);

    const candidates = new Set<string>();
    if (own) {
        for (const name of [asName(own.name), ...aliasesOf(own)]) {
            if (name && name !== requested && !isMovingAlias(name)) candidates.add(name);
        }
    }
    for (const entry of listed) {
        const id = asName(entry.id);
        if (!id || id === requested || isMovingAlias(id)) continue;
        if (aliasesOf(entry).includes(requested)) candidates.add(id);
    }

    const found = [...candidates].sort();
    if (found.length === 1) return { resolvedModelId: found[0], outcome: "resolved", candidates: found };
    if (found.length > 1) return { resolvedModelId: null, outcome: "ambiguous", candidates: found };
    return {
        resolvedModelId: null,
        // Nothing behind it, and no entry for it, are different states: the
        // first says the provider is silent, the second that we asked about
        // something it does not serve.
        outcome: own ? "no-alias-recorded" : "not-listed",
        candidates: found,
    };
};

/**
 * Whether a recorded `modelVersion` is the request handed back rather than an
 * answer. An echo is not evidence of which model replied, and a reviewer
 * comparing two echoes across batches would read a match that means nothing.
 */
export const isEchoOfRequest = (
    requestedApiModel: string | null | undefined,
    modelVersion: string | null | undefined
): boolean => {
    const requested = asName(requestedApiModel);
    const reported = asName(modelVersion);
    return requested !== null && reported !== null && requested === reported;
};
