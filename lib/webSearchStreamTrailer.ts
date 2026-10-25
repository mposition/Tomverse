import {
  parseChatCompletionOutcome,
  type ChatCompletionStatus,
  type ChatIncompleteReason,
} from "@tomverse/chat-core";
import {
  parseChatStreamArtifacts,
  type ChatStreamArtifact,
} from "@/lib/generatedArtifactCore";

// A provider-executed search tool call only resolves once the whole
// streamText() turn settles (tool-result/source parts only exist in the
// final AI SDK `content` array), so per-turn WebSearchExecution metadata
// can't be known until after the last text token has already streamed to
// the client. Response headers are fixed before any body bytes go out, so
// they can't carry it either. This appends one final out-of-band chunk to
// the same text stream instead of opening a second request -- the only
// delivery path that also reaches guest sessions, whose messages are never
// persisted server-side for a later re-fetch.
//
// The marker starts with a NUL code point (\u0000), which providers do not
// emit in normal completions, so real model output can't collide with it.
import { buildSearchMetadataTrailerChunk } from "@tomverse/chat-core";
export { SEARCH_METADATA_TRAILER_MARKER, buildSearchMetadataTrailerChunk, splitSearchMetadataTrailer } from "@tomverse/chat-core";

export type ChatStreamTrailer = {
  searchMetadata: unknown;
  completion?: {
    status: ChatCompletionStatus;
    incompleteReason?: ChatIncompleteReason;
  };
  /**
   * The files this turn produced (docs/policy/generated-artifacts.md section 5).
   *
   * Here for the same reason the citations are: a tool result only resolves
   * once the whole turn settles, so it cannot ride in a header, and a guest
   * turn has no persisted message to re-fetch it from. Carries public fields
   * only -- no object key, no storage URL, nothing the provider said.
   *
   * Absent, not empty, when the turn made no file. An older client ignores the
   * key; an older server never sends it and the client shows no cards, which
   * is exactly right for a turn that had none.
   */
  artifacts?: ChatStreamArtifact[];
};

export function buildChatStreamTrailerChunk(trailer: ChatStreamTrailer): string {
  return buildSearchMetadataTrailerChunk(trailer);
}

/**
 * Reads a trailer payload back.
 *
 * Accepts both the envelope above and a bare WebSearchExecution object, which
 * is what the trailer carried before it also had to report completion status.
 * A client can meet an old server (a rolling deploy) or a stored fixture, and
 * a bare payload simply means "no completion information" -- never a wrong
 * status.
 */
export function parseChatStreamTrailer(
  searchMetadataJson: string | null
): ChatStreamTrailer | null {
  if (!searchMetadataJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(searchMetadataJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    !("searchMetadata" in record) &&
    !("completion" in record) &&
    !("artifacts" in record)
  ) {
    return { searchMetadata: parsed };
  }
  const completion = parseChatCompletionOutcome(record.completion);
  const artifacts = parseChatStreamArtifacts(record.artifacts);
  return {
    searchMetadata: record.searchMetadata ?? null,
    ...(completion ? { completion } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}
