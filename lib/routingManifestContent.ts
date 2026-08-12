// What a ContextManifest records about a request, without recording the
// request (docs/policy/tomverse-chat-routing.md §5, delivery plan §5).
//
// The manifest exists to prove what was sent. The obvious way to prove it is
// to keep a copy, and both policies say not to: "Store source IDs plus
// immutable versions/hashes ... do not duplicate raw prompts." A copy would
// also give the user's words a second home with a different retention policy
// from the conversation they came from, so deleting the conversation would
// leave them behind.
//
// So the proof is a hash and a shape. This module turns the messages actually
// being sent into:
//
//   - source references: role, position, kind and a keyed digest per part,
//     with sizes. Enough to say "the third message was a 2.4 kB user text and
//     a 1.1 MB PDF" and to prove a later copy is the same one;
//   - an effective-request hash over everything that decides what the provider
//     receives -- model, settings, tool configuration and the message digests.
//
// Keyed rather than bare digests. A bare SHA-256 of a short message is
// reversible by anyone willing to guess: "yes", "네", a phone number and most
// single sentences fall to a dictionary in seconds. Keying with the
// application secret means a leaked manifest table is not a lookup away from
// the conversations it describes.

import { createHmac } from "node:crypto";

/** Bump when the digest inputs or their order change. */
export const MANIFEST_CONTENT_VERSION = "manifest-content-v1";

export type ManifestMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType?: string; bytes?: number }
  | { type: "other"; label: string };

export type ManifestMessage = {
  role: string;
  parts: readonly ManifestMessagePart[];
};

export type ManifestSourceRef = {
  /** Position in the message array actually sent. */
  index: number;
  role: string;
  parts: {
    kind: "text" | "file" | "other";
    /** Bytes of text, or of the attachment. Size is a shape, not content. */
    bytes: number;
    /** Only for files, and only the type -- never the filename. */
    mediaType?: string;
    digest: string;
  }[];
};

const digest = (secret: string, scope: string, value: string) =>
  createHmac("sha256", secret)
    .update(`${MANIFEST_CONTENT_VERSION}:${scope}:${value}`)
    .digest("hex");

/**
 * One reference per message, one digest per part.
 *
 * Per part rather than per message so a manifest can show that a turn's text
 * was unchanged while its attachment differed -- which is the difference
 * between a retry and a new question, and is invisible if the two are hashed
 * together.
 */
export const buildManifestSourceRefs = (
  messages: readonly ManifestMessage[],
  secret: string
): ManifestSourceRef[] =>
  messages.map((message, index) => ({
    index,
    role: message.role,
    parts: message.parts.map((part) => {
      if (part.type === "text") {
        return {
          kind: "text" as const,
          bytes: Buffer.byteLength(part.text, "utf8"),
          digest: digest(secret, "text", part.text),
        };
      }
      if (part.type === "file") {
        return {
          kind: "file" as const,
          bytes: part.bytes ?? 0,
          mediaType: part.mediaType,
          // A file's bytes are not hashed here: the attachment is already
          // stored and referenced elsewhere, and streaming it through a digest
          // on the request path would cost more than the proof is worth. Type
          // and size are the shape this record needs.
          digest: digest(secret, "file", `${part.mediaType ?? ""}:${part.bytes ?? 0}`),
        };
      }
      return {
        kind: "other" as const,
        bytes: 0,
        digest: digest(secret, "other", part.label),
      };
    }),
  }));

export type EffectiveRequestInput = {
  modelId: string;
  provider: string;
  maxOutputTokens: number;
  /** Provider-specific generation settings, already resolved. */
  settings?: Readonly<Record<string, unknown>>;
  /** Tool configuration as sent, or null when no tool is offered. */
  toolConfig?: unknown;
  sourceRefs: readonly ManifestSourceRef[];
};

/**
 * Deterministic ordering, so the same request hashes the same way twice.
 *
 * `JSON.stringify` follows insertion order, which differs between two objects
 * that carry the same settings assembled in a different order -- and a hash
 * that changes when nothing did proves nothing.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
};

/**
 * The hash §5 step 4 requires: everything that decides what the provider
 * receives, and nothing else.
 *
 * The message digests carry the content's identity, so the prompt itself
 * never enters. Two requests differing only in their text produce different
 * hashes through the digests; two requests identical in every respect produce
 * the same hash whether or not anyone kept the text.
 */
export const effectiveRequestHash = (
  input: EffectiveRequestInput,
  secret: string
) =>
  digest(
    secret,
    "effective-request",
    JSON.stringify(
      canonical({
        modelId: input.modelId,
        provider: input.provider,
        maxOutputTokens: input.maxOutputTokens,
        settings: input.settings ?? {},
        toolConfig: input.toolConfig ?? null,
        sourceRefs: input.sourceRefs,
      })
    )
  );

/** Total bytes referenced, for the run's own record of what it sent. */
export const manifestSourceBytes = (refs: readonly ManifestSourceRef[]) =>
  refs.reduce(
    (total, ref) => total + ref.parts.reduce((sum, part) => sum + part.bytes, 0),
    0
  );
