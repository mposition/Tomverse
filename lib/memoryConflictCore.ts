import { memoryStatementKey } from "./memoryValidatorCore";

/** A model-proposed topic is a review hint, never permission to change a memory. */
export const MEMORY_CANONICAL_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/;

export function isMemoryCanonicalKey(value: unknown): value is string {
    return typeof value === "string" && value.length <= 96 &&
        MEMORY_CANONICAL_KEY_PATTERN.test(value);
}

export function memoryConflictKey(kind: string, statement: string, canonicalKey?: string | null): string {
    return isMemoryCanonicalKey(canonicalKey)
        ? `topic:${kind}:${canonicalKey}`
        : `${kind}:${memoryStatementKey(statement)}`;
}

export function memoryCanonicalKey(conflictKey: string | null): string | null {
    const value = conflictKey?.match(/^topic:[a-z_]+:(.+)$/)?.[1];
    return isMemoryCanonicalKey(value) ? value : null;
}
