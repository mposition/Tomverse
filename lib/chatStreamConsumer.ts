/**
 * Reading the chat response stream: what the user sees, and what the
 * liveness watchdog is told about it.
 *
 * This was the body of a `while (true)` loop inside
 * `components/chat/ChatApp.tsx`. It is out here because the bug it now
 * carries the fix for -- a high-reasoning turn reported to the user as
 * something the user had done -- is a bug about *timing*, and timing was the
 * one thing about that loop nothing could execute: the panel is a client
 * component, the unit lane cannot mount one, and the alternative was a test
 * that re-implements the loop and then agrees with itself.
 *
 * Nothing about the wire format changed in the move. Five out-of-band
 * channels share the stream, all led by a NUL code point that providers do
 * not emit in normal completions, and all stripped on **every pass** rather
 * than once at the end -- the answer is rendered as it streams, and a marker
 * left in for even one frame is a marker the user reads:
 *
 *   * lib/routingRetrySignal.ts     -- a fallback swapped the model
 *   * lib/chatStreamKeepalive.ts    -- the provider is still thinking or still
 *                                      producing non-visible parts, or the
 *                                      server has stopped waiting for it
 *   * lib/generatedArtifactProgressSignal.ts -- a file is being built
 *   * lib/chatReasoningDisplay.ts   -- the provider's reasoning summary
 *   * lib/webSearchStreamTrailer.ts -- the closing metadata object
 *
 * The order matters only in that each splitter is handed the previous one's
 * remaining text, so a marker cannot hide inside another marker's payload.
 */

import { chatStreamDisplayText } from "@tomverse/chat-core";
import { mcpProgressFromStream, type McpProgressState } from "@/lib/mcpConnectorProgress";
import { splitStreamKeepaliveSignal } from "@/lib/chatStreamKeepalive";
import { splitArtifactProgressSignal } from "@/lib/generatedArtifactProgressSignal";
import { splitChatReasoning, type ChatReasoningView } from "@/lib/chatReasoningDisplay";
import { splitRoutingRetrySignal } from "@/lib/routingRetrySignal";
import { splitSearchMetadataTrailer } from "@/lib/webSearchStreamTrailer";
import type { ChatTimeoutErrorCode } from "@/lib/chatStreamLiveness";

export type ChatStreamProgress = {
  mcpProgress?: McpProgressState;
  /** The answer as it should be rendered right now. Markers removed. */
  displayText: string;
  /** Set once §7 announced that another model took the turn over. */
  retryingWithModelId: string | null;
  /** The "building a file" card, until the trailer says what came of it. */
  isGeneratingArtifact: boolean;
  generatingArtifactFormat: string | null;
  /** The provider's reasoning summary so far, or null when none was sent. */
  reasoning: ChatReasoningView | null;
};

export type ChatStreamResult = ChatStreamProgress & {
  /** The trailer's raw JSON, for `parseChatStreamTrailer`. */
  searchMetadataJson: string | null;
  /**
   * Set when the server wrote its terminal `stalled` keepalive -- it stopped
   * waiting for a provider that had produced nothing, and has already
   * cancelled the provider reader, settled, released its lease and discarded
   * any artifact. Distinct from a stream that simply closed with no text,
   * which is the provider having finished and said nothing.
   */
  serverStallCode: ChatTimeoutErrorCode | null;
};

/**
 * Only the calls this loop makes, so a test can pass a counter and the
 * component can pass the real watchdog.
 */
export type ChatStreamLivenessSink = {
  noteKeepalive: (serverIntervalMs?: number) => void;
  noteVisibleChunk: () => void;
  /** Any other chunk the server wrote. Optional for older test sinks. */
  noteServerSignal?: () => void;
};

export const consumeChatStream = async (input: {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  liveness: ChatStreamLivenessSink;
  /** Called after every chunk that changed anything the user can see. */
  onProgress: (progress: ChatStreamProgress) => void;
  /**
   * Called once, just before the read error is rethrown, when the stream
   * broke instead of closing. Handed the trailer JSON if one had already
   * arrived: a server that fails a turn mid-stream writes its error report
   * there and only then errors the stream, so the report is in hand by the
   * time the read rejects (lib/webSearchStreamTrailer.ts, `errorReport`).
   */
  onInterrupted?: (searchMetadataJson: string | null) => void;
}): Promise<ChatStreamResult> => {
  const { reader, liveness, onProgress } = input;
  const decoder = new TextDecoder();

  /*
    The untouched accumulation.

    Every splitter runs against the whole of it on every pass rather than
    against the chunk that just arrived, because a stream is not delivered in
    the pieces it was written in: a marker and its JSON payload can be torn
    across two reads, and half a marker is not answer text.
  */
  let rawStreamText = "";
  let displayText = "";
  let retryingWithModelId: string | null = null;
  let isGeneratingArtifact = false;
  let generatingArtifactFormat: string | null = null;
  let reasoning: ChatReasoningView | null = null;
  let serverStallCode: ChatTimeoutErrorCode | null = null;
  // Complete keepalive markers already reported. The splitter runs over the
  // whole accumulation each pass, so its last signal is the same object on
  // every later pass; only a higher count is a keepalive that just arrived.
  let keepalivesSeen = 0;

  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch (error) {
      input.onInterrupted?.(
        splitSearchMetadataTrailer(rawStreamText).searchMetadataJson
      );
      throw error;
    }
    const { done, value } = read;
    if (done) break;

    rawStreamText += decoder.decode(value, { stream: true });

    const routing = splitRoutingRetrySignal(rawStreamText);
    if (routing.signal) retryingWithModelId = routing.signal.modelId;

    const keepalive = splitStreamKeepaliveSignal(routing.text);
    const keepaliveArrived = keepalive.count > keepalivesSeen;
    if (keepaliveArrived) {
      keepalivesSeen = keepalive.count;
      // Resets the silence clock and nothing else. It deliberately does not
      // extend the first-response deadline -- see lib/chatStreamLiveness.ts
      // -- or a provider that had permanently stopped would be hidden for as
      // long as the server kept writing.
      liveness.noteKeepalive(keepalive.signal?.intervalMs);
    }
    if (keepalive.signal?.state === "stalled") {
      serverStallCode = keepalive.signal.code ?? "CHAT_FIRST_RESPONSE_TIMEOUT";
    }

    const artifactProgress = splitArtifactProgressSignal(keepalive.text);
    if (artifactProgress.signal) {
      isGeneratingArtifact = true;
      generatingArtifactFormat = artifactProgress.signal.format;
    }

    // Not progress either: the summary is shown beside the answer, and a
    // model that thinks for minutes must not look like one that answered.
    reasoning = splitChatReasoning(artifactProgress.text).reasoning;

    const previousLength = displayText.length;
    displayText = chatStreamDisplayText(rawStreamText);

    // Progress as the user would judge it: answer text that grew, or the card
    // saying a file is being built. An out-of-band marker on its own is not
    // progress, and counting it as progress is exactly how a keepalive would
    // end up restarting the clock it exists to be independent of.
    const advanced =
      displayText.length > previousLength || Boolean(artifactProgress.signal);
    if (advanced) liveness.noteVisibleChunk();
    // A routing notice, a progress marker, the trailer, or the torn first
    // half of a keepalive: the server is writing, which is all the silence
    // watchdog asks. It is not progress, so the phase stays where it was.
    else if (!keepaliveArrived) liveness.noteServerSignal?.();

    onProgress({
      ...(mcpProgressFromStream(rawStreamText) ? { mcpProgress: mcpProgressFromStream(rawStreamText) } : {}),
      displayText,
      retryingWithModelId,
      isGeneratingArtifact,
      generatingArtifactFormat,
      reasoning,
    });
  }

  // One final pass over the whole accumulation. The trailer arrives last and
  // is the only marker whose payload is read after the stream ends.
  const finalRouting = splitRoutingRetrySignal(rawStreamText);
  if (finalRouting.signal) retryingWithModelId = finalRouting.signal.modelId;
  const finalKeepalive = splitStreamKeepaliveSignal(finalRouting.text);
  if (finalKeepalive.signal?.state === "stalled") {
    serverStallCode = finalKeepalive.signal.code ?? "CHAT_FIRST_RESPONSE_TIMEOUT";
  }
  const { searchMetadataJson } =
    splitSearchMetadataTrailer(
      splitArtifactProgressSignal(finalKeepalive.text).text
    );

  return {
    displayText: chatStreamDisplayText(rawStreamText),
    retryingWithModelId,
    isGeneratingArtifact,
    generatingArtifactFormat,
    reasoning: splitChatReasoning(splitArtifactProgressSignal(finalKeepalive.text).text).reasoning,
    searchMetadataJson,
    serverStallCode,
  };
};
