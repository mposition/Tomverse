import { createHash } from "node:crypto";

/**
 * Content digests for external conversation import (Release A).
 *
 * Contract: docs/policy/external-conversation-import-and-memory.md §4.1.
 *
 * The client parses export archives in a Web Worker and sends normalized
 * text; whatever fingerprint it attaches is a *hint* for fast duplicate-
 * candidate detection and nothing more. Deduplication, idempotency and the
 * per-account unique index all key on digests the server recomputes here,
 * from the bytes it actually received — a tampering client can only corrupt
 * its own import, never smuggle a duplicate past the backstop.
 *
 * digestVersion 1 pins:
 *
 *   * SHA-256, lowercase hex;
 *   * content canonicalization = Unicode NFC + CRLF/CR -> LF. Nothing else:
 *     trimming or whitespace collapsing would make two genuinely different
 *     source messages collide;
 *   * the exact field layout of each composite digest below. Any change to
 *     the layout is a new digestVersion, never an in-place edit — rows store
 *     the version they were computed with, and a re-import must be able to
 *     reproduce an old row's digest to recognise it as a duplicate.
 *
 * A message's *dedup* digest hashes the pre-truncation content digest when
 * the message was truncated (§5.4): whether the user approved truncation
 * must not change the identity of the source conversation.
 */

export const EXTERNAL_IMPORT_DIGEST_VERSION = 1;

export type ExternalImportProvider = "chatgpt" | "claude";

export type ExternalMessageRole = "user" | "assistant";

/** NFC + line-ending normalization. The only canonicalization applied to content. */
export function canonicalizeExternalContent(content: string): string {
    return content.normalize("NFC").replace(/\r\n?/g, "\n");
}

function sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Digest of a message's canonicalized content (stored as `contentDigest` /
 * `originalContentDigest`). */
export function externalContentDigest(content: string): string {
    return sha256Hex(canonicalizeExternalContent(content));
}

/**
 * Stable identifier for a provider-side conversation, stored instead of the
 * raw external ID (`ExternalConversation.externalStableId`). Scoped to the
 * owner so two accounts importing the same shared conversation do not
 * produce correlatable values.
 */
export function externalConversationStableId(input: {
    provider: ExternalImportProvider;
    userId: string;
    rawExternalConversationId: string;
}): string {
    return sha256Hex(
        `${input.provider}\n${input.userId}\n${input.rawExternalConversationId}`
    );
}

/** Stable identifier for a provider-side message (`ExternalMessage.externalStableId`). */
export function externalMessageStableId(input: {
    provider: ExternalImportProvider;
    userId: string;
    rawExternalConversationId: string;
    rawExternalMessageId: string;
}): string {
    return sha256Hex(
        `${input.provider}\n${input.userId}\n${input.rawExternalConversationId}\n${input.rawExternalMessageId}`
    );
}

/**
 * Dedup digest of one message. `sourceContentDigest` must be the
 * pre-truncation content digest for truncated messages (§4.1).
 */
export function externalMessageDedupDigest(input: {
    provider: ExternalImportProvider;
    rawExternalConversationId: string;
    role: ExternalMessageRole;
    ordinal: number;
    sourceContentDigest: string;
}): string {
    if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
        throw new Error("ordinal must be a non-negative integer");
    }
    return sha256Hex(
        `${input.provider}\n${input.rawExternalConversationId}\n${input.role}\n${input.ordinal}\n${input.sourceContentDigest}`
    );
}

/**
 * Digest of a whole conversation (`ExternalConversation.conversationDigest`).
 * Message digests must already be in ordinal order — this function hashes
 * exactly what it is given, because reordering here would hide an adapter
 * that emits messages out of order.
 */
export function externalConversationDigest(input: {
    provider: ExternalImportProvider;
    rawExternalConversationId: string;
    orderedMessageDedupDigests: readonly string[];
}): string {
    return sha256Hex(
        `${input.provider}\n${input.rawExternalConversationId}\n${input.orderedMessageDedupDigests.join("")}`
    );
}

/**
 * Digest of one finalized import (`ExternalImport.importDigest`). Sorted, not
 * order-preserving: the same selection of conversations is the same import
 * regardless of the order batches arrived in.
 */
export function externalImportDigest(
    conversationDigests: readonly string[]
): string {
    return sha256Hex([...conversationDigests].sort().join(""));
}
