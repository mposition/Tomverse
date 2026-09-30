import "server-only";

import { createHash } from "node:crypto";

const MESSAGE_REQUEST_NAMESPACE = "tomverse:conversation-message:v1";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/**
 * Turns a browser-generated request id into the Message primary key used by
 * the database. The conversation id is part of the hash namespace, so a UUID
 * copied from another conversation is only opaque input and can never address
 * that other conversation's Message row.
 *
 * The UUID uses RFC 9562's custom/version-8 slot and the RFC variant. This is
 * deterministic for retries but is not a client capability or a reversible
 * encoding of either input.
 */
export function scopedMessageId(
  conversationId: string,
  clientRequestId: string
): string {
  const digest = createHash("sha256")
    .update(MESSAGE_REQUEST_NAMESPACE, "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .update("\0", "utf8")
    .update(clientRequestId, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const value = hex(digest);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
