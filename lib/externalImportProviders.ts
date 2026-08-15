/**
 * The provider set for external conversation import — one canonical list.
 *
 * docs/policy/external-conversation-import-and-memory.md §4.1, §5.6, and the
 * A2 design's §3.
 *
 * This module exists because the set was written out four times: in the
 * adapter union, in the digest union, in the create route's request schema,
 * and in two database CHECK constraints. Gemini was added to the first and
 * not the others, so the browser parsed a Takeout export and the server
 * refused to create the import for it -- a failure no type could catch,
 * because the value crosses that boundary as JSON.
 *
 * Anything that needs to know which providers exist reads this. The database
 * cannot: SQL does not import TypeScript, so a constraint carries its own
 * copy and tests/integration/external-import-provider-canon.db.test.ts holds
 * the two together.
 *
 * Pure and isomorphic — it is imported by the browser worker and by server
 * routes alike, so nothing platform-specific belongs here.
 */

export const EXTERNAL_IMPORT_PROVIDERS = [
    "chatgpt",
    "claude",
    "gemini",
] as const;

export type ExternalImportProvider = (typeof EXTERNAL_IMPORT_PROVIDERS)[number];

export function isExternalImportProvider(
    value: unknown
): value is ExternalImportProvider {
    return (
        typeof value === "string" &&
        (EXTERNAL_IMPORT_PROVIDERS as readonly string[]).includes(value)
    );
}
