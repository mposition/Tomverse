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

export type RevokedPairsState =
    | { kind: "none" }
    | { kind: "revoked"; pairs: MemoryExtractionPairRef[] }
    | { kind: "revoke_all"; reason: "malformed" };

/**
 * Parses the stored revocation list: a JSON array of
 * `"<modelId>::<promptVersion>"` strings. Absent/empty → nothing revoked;
 * anything unparsable → everything revoked (see module comment).
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
    const pairs: MemoryExtractionPairRef[] = [];
    for (const entry of parsed) {
        if (typeof entry !== "string") {
            return { kind: "revoke_all", reason: "malformed" };
        }
        const separator = entry.indexOf("::");
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
