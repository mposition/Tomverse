/**
 * The explicit project references a question carries (search-hit `ref`s the
 * user chose). Dependency-free on purpose: the chat send path imports it.
 */

/** The most references one question may name; the same bound the server applies. */
export const MAX_PROJECT_REFERENCES = 8;

/** The `projectReferences` a request carries; omitted entirely when nothing is selected. */
export function projectReferenceFields(references: readonly string[] | null | undefined): { projectReferences?: string[] } {
    const unique = [...new Set((references ?? []).filter((ref) => typeof ref === "string" && ref.length >= 3 && ref.length <= 200))].slice(0, MAX_PROJECT_REFERENCES);
    return unique.length > 0 ? { projectReferences: unique } : {};
}
