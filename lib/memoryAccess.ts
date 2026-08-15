/**
 * Pure flag and revocation semantics for account memory (Release B).
 *
 * docs/policy/external-conversation-import-and-memory.md §12.1, §15.
 *
 * Both flags are rollout flags in the externalImportAccess mould: default
 * OFF, enabled only by an explicit AppSetting opt-in row, missing
 * configuration fails closed. Injection additionally requires the §12.4
 * human activation procedure before it may ever be turned on.
 *
 * Emergency pair revocation (§12.1) is the one runtime override the code
 * register does not own: `AppSetting["memoryExtractionRevokedPairs"]` lists
 * pairs an operator has pulled without a deploy. Parsing is fail-closed in
 * the dangerous direction — a malformed revocation list must never silently
 * *un*-revoke, so it reads as "everything revoked" until fixed.
 */

export const MEMORY_EXTRACTION_FLAG_KEY = "feature.memoryExtractionEnabled";
export const MEMORY_INJECTION_FLAG_KEY = "feature.memoryInjectionEnabled";
export const MEMORY_EXTRACTION_REVOKED_PAIRS_KEY =
    "memoryExtractionRevokedPairs";

export function memoryExtractionEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}

export function memoryInjectionEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}

export type MemoryExtractionPairRef = {
    extractionModelId: string;
    promptVersion: string;
};

/**
 * Why everything is revoked.
 *
 * `operator` is a person having stopped extraction on purpose; `malformed` is
 * the row being unreadable. Both fail closed identically, and nothing branches
 * on this — it exists so the admin screen and the audit trail can tell a
 * deliberate stop from a corrupted setting, which are the same state and very
 * different situations.
 */
export type RevokeAllReason = "malformed" | "operator";

export type RevokedPairsState =
    | { kind: "none" }
    | { kind: "revoked"; pairs: MemoryExtractionPairRef[] }
    | { kind: "revoke_all"; reason: RevokeAllReason };

/** The one entry that means "all pairs", written by the admin stop control. */
export const REVOKE_ALL_ENTRY = "*";

export const PAIR_LABEL_SEPARATOR = "::";

export const memoryPairLabel = (pair: MemoryExtractionPairRef) =>
    `${pair.extractionModelId}${PAIR_LABEL_SEPARATOR}${pair.promptVersion}`;

/**
 * Parses the stored revocation list: a JSON array of
 * `"<modelId>::<promptVersion>"` strings, or `["*"]` for a deliberate stop.
 * Absent/empty → nothing revoked; anything unparsable → everything revoked
 * (see module comment).
 */
export function parseRevokedPairs(
    value: string | null | undefined
): RevokedPairsState {
    if (value == null || value.trim() === "") return { kind: "none" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return { kind: "revoke_all", reason: "malformed" };
    }
    if (!Array.isArray(parsed)) return { kind: "revoke_all", reason: "malformed" };
    // Checked before the per-entry loop so `["*"]` reads as the deliberate
    // stop it is rather than falling through to "malformed". A model id can
    // never be `*`, so a list mixing it with pairs is still a stop.
    if (parsed.includes(REVOKE_ALL_ENTRY)) {
        return { kind: "revoke_all", reason: "operator" };
    }
    const pairs: MemoryExtractionPairRef[] = [];
    for (const entry of parsed) {
        if (typeof entry !== "string") {
            return { kind: "revoke_all", reason: "malformed" };
        }
        const separator = entry.indexOf(PAIR_LABEL_SEPARATOR);
        if (separator <= 0 || separator === entry.length - 2) {
            return { kind: "revoke_all", reason: "malformed" };
        }
        pairs.push({
            extractionModelId: entry.slice(0, separator),
            promptVersion: entry.slice(separator + 2),
        });
    }
    if (pairs.length === 0) return { kind: "none" };
    return { kind: "revoked", pairs };
}

/** What an operator asked for, before it becomes a stored string. */
export type RevokedPairsRequest =
    | { mode: "none" }
    | { mode: "pairs"; labels: readonly string[] }
    | { mode: "all" };

/**
 * Why a requested revocation cannot be stored as asked.
 *
 * Every one of these would otherwise round-trip through `parseRevokedPairs`
 * as `revoke_all: malformed` -- a typo in a single label stops extraction
 * everywhere, and reads afterwards as a corrupted row rather than as the typo
 * it was. Refusing at the edge is what makes a validated control safer than
 * the hand-written `UPDATE` this replaces.
 */
export function revokedPairsRequestProblems(
    request: RevokedPairsRequest
): string[] {
    if (request.mode !== "pairs") return [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const label of request.labels) {
        if (label !== label.trim() || label === "") {
            problems.push(`"${label}" must not be empty or padded with spaces`);
            continue;
        }
        if (label === REVOKE_ALL_ENTRY) {
            problems.push(
                `"${REVOKE_ALL_ENTRY}" is the stop-everything control, not a pair. ` +
                    `Use the explicit stop instead of listing it as one.`
            );
            continue;
        }
        const parts = label.split(PAIR_LABEL_SEPARATOR);
        if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
            problems.push(
                `"${label}" must be exactly "<extractionModelId>${PAIR_LABEL_SEPARATOR}<promptVersion>"`
            );
            continue;
        }
        if (seen.has(label)) problems.push(`"${label}" is listed twice`);
        seen.add(label);
    }
    return problems;
}

/**
 * The stored value for a request. Only ever called on a request that
 * `revokedPairsRequestProblems` accepted, so the result always reads back as
 * the state that was asked for.
 */
export function serializeRevokedPairs(request: RevokedPairsRequest): string {
    if (request.mode === "all") return JSON.stringify([REVOKE_ALL_ENTRY]);
    if (request.mode === "none") return JSON.stringify([]);
    return JSON.stringify([...request.labels]);
}

export function isPairRevoked(
    state: RevokedPairsState,
    pair: MemoryExtractionPairRef
): boolean {
    if (state.kind === "none") return false;
    if (state.kind === "revoke_all") return true;
    return state.pairs.some(
        (revoked) =>
            revoked.extractionModelId === pair.extractionModelId &&
            revoked.promptVersion === pair.promptVersion
    );
}
