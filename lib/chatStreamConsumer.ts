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
 * Nothing about the wire format changed in the move. Four out-of-band
 * channels share the stream, all led by a NUL code point that providers do
 * not emit in normal completions, and all stripped on **every pass** rather
 * than once at the end -- the answer is rendered as it streams, and a marker
 * left in for even one frame is a marker the user reads:
 *
 *   * lib/routingRetrySignal.ts     -- a fallback swapped the model
 *   * lib/chatStreamKeepalive.ts    -- the provider is still thinking, or the
 *                                      server has stopped waiting for it
 *   * lib/generatedArtifactProgressSignal.ts -- a file is being built
 *   * lib/webSearchStreamTrailer.ts -- the closing metadata object
 *
 * The order matters only in that each splitter is handed the previous one's
 * remaining text, so a marker cannot hide inside another marker's payload.
 */

import { splitStreamKeepaliveSignal } from "@/lib/chatStreamKeepalive";
import { splitArtifactProgressSignal } from "@/lib/generatedArtifactProgressSignal";
import { splitRoutingRetrySignal } from "@/lib/routingRetrySignal";
import { splitSearchMetadataTrailer } from "@/lib/webSearchStreamTrailer";
import type { ChatTimeoutErrorCode } from "@/lib/chatStreamLiveness";

/**
 * Holds back a control marker that has only partly arrived.
 *
 * Each splitter above recognises its own marker and drops a payload it cannot
 * finish reading. None of them can do anything about a read that ends in the
 * middle of the marker *name* -- `splitStreamKeepaliveSignal` is looking for
 * the whole string, so a chunk that stops after the leading NUL and three
 * letters is simply not a keepalive yet, and the accumulation is returned
 * unchanged with those four characters in it.
 *
 * Providers do not emit NUL in normal completions -- that is the entire
 * reason these markers are led by one -- so a NUL still present after every
 * splitter has run belongs to a marker that is still arriving. Everything
 * from it onwards is held back until the read that completes it. On a stream
 * that ended there instead, it is a marker the server never finished writing,
 * and dropping it is the same decision the splitters make about a truncated
 * payload.
 */
const NUL = String.fromCharCode(0);

const withoutPendingMarker = (text: string): string => {
  const index = text.indexOf(NUL);
  return index === -1 ? text : text.slice(0, index);
};

export type ChatStreamProgress = {
  /** The answer as it should be rendered right now. Markers removed. */
  displayText: string;
  /** Set once §7 announced that another model took the turn over. */
  retryingWithModelId: string | null;
  /** The "building a file" card, until the trailer says what came of it. */
  isGeneratingArtifact: boolean;
  generatingArtifactFormat: string | null;
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
 * Only the two calls this loop makes, so a test can pass a counter and the
 * component can pass the real watchdog.
 */
export type ChatStreamLivenessSink = {
  noteKeepalive: () => void;
  noteVisibleChunk: () => void;
};

export const consumeChatStream = async (input: {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  liveness: ChatStreamLivenessSink;
  /** Called after every chunk that changed anything the user can see. */
  onProgress: (progress: ChatStreamProgress) => void;
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
  let serverStallCode: ChatTimeoutErrorCode | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    rawStreamText += decoder.decode(value, { stream: true });

    const routing = splitRoutingRetrySignal(rawStreamText);
    if (routing.signal) retryingWithModelId = routing.signal.modelId;

    const keepalive = splitStreamKeepaliveSignal(routing.text);
    if (keepalive.signal) {
      // Proof that the transport is alive and nothing else. It deliberately
      // does not extend the first-response deadline -- see
      // lib/chatStreamLiveness.ts -- or a provider that had permanently
      // stopped would be hidden for as long as the server kept writing.
      liveness.noteKeepalive();
      if (keepalive.signal.state === "stalled") {
        serverStallCode = keepalive.signal.code ?? "CHAT_FIRST_RESPONSE_TIMEOUT";
      }
    }

    const artifactProgress = splitArtifactProgressSignal(keepalive.text);
    if (artifactProgress.signal) {
      isGeneratingArtifact = true;
      generatingArtifactFormat = artifactProgress.signal.format;
    }

    const previousLength = displayText.length;
    displayText = withoutPendingMarker(
      splitSearchMetadataTrailer(artifactProgress.text).displayText
    );

    // Progress as the user would judge it: answer text that grew, or the card
    // saying a file is being built. An out-of-band marker on its own is not
    // progress, and counting it as progress is exactly how a keepalive would
    // end up restarting the clock it exists to be independent of.
    const advanced =
      displayText.length > previousLength || Boolean(artifactProgress.signal);
    if (advanced) liveness.noteVisibleChunk();

    onProgress({
      displayText,
      retryingWithModelId,
      isGeneratingArtifact,
      generatingArtifactFormat,
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
  const { displayText: finalText, searchMetadataJson } =
    splitSearchMetadataTrailer(
      splitArtifactProgressSignal(finalKeepalive.text).text
    );

  return {
    displayText: withoutPendingMarker(finalText),
    retryingWithModelId,
    isGeneratingArtifact,
    generatingArtifactFormat,
    searchMetadataJson,
    serverStallCode,
  };
};
