/**
 * The chunk the server writes while it is waiting for a provider's first
 * token, and the one it writes when it stops waiting.
 *
 * ## Why the stream needs anything at all
 *
 * This deployment's origin runs on Railway behind Cloudflare, whose Proxy
 * Read Timeout is 125 seconds by default and adjustable only on Enterprise
 * zones: an origin that sends nothing for longer has its connection closed
 * with a 524. docs/policy/image-generation.md section 7 records the same
 * limit -- it is why image generation is claim-based instead of a synchronous
 * handler. A `claude-fable-5` turn runs adaptive thinking at `effort:
 * "high"`, so several minutes can pass between the response headers and the
 * first visible token, with not one byte on the wire in between. The proxy
 * ends that connection long before the model is finished thinking, and the
 * browser sees a broken stream rather than an answer.
 *
 * A byte every 20 seconds keeps the connection legibly alive. It has to be
 * out-of-band, because anything in-band is an answer the user reads.
 *
 * ## Why it is not allowed to be reassuring
 *
 * A keepalive that never stops is a stalled provider hidden forever. So the
 * same marker carries a terminal state: when the server's own first-token
 * deadline (lib/chatStreamLiveness.ts) expires, it writes `stalled` with the
 * error code and closes -- having cancelled the provider reader, settled the
 * reservation, released the concurrency lease and discarded any artifact it
 * had collected. The client's own absolute first-response budget is never
 * extended by a keepalive, so even a server that kept writing them forever
 * would still be given up on.
 *
 * ## Wire format
 *
 * Same convention as lib/webSearchStreamTrailer.ts and
 * lib/routingRetrySignal.ts: a chunk led by a NUL code point, which providers
 * do not emit in normal completions, followed by one JSON object. A stream is
 * not delivered in the pieces it was written in, so the splitter finds the
 * object's matching brace rather than assuming a chunk boundary, and drops a
 * truncated marker instead of rendering half of one.
 */

const NUL = String.fromCharCode(0);

export const STREAM_KEEPALIVE_MARKER = `${NUL}TOMVERSE_STREAM_KEEPALIVE`;

export type ChatStreamKeepaliveSignal = {
  /**
   * `awaiting_first_token` -- the server is still holding the provider stream
   * open and nothing has arrived. `stalled` -- it gave up, and the turn is
   * over.
   */
  state: "awaiting_first_token" | "stalled";
  /** Since the provider was dispatched. Diagnostics only. */
  elapsedMs: number;
  /** Present on `stalled` only, and always this one code. */
  code?: "CHAT_FIRST_RESPONSE_TIMEOUT";
};

export const buildStreamKeepaliveChunk = (
  signal: ChatStreamKeepaliveSignal
): string => `${STREAM_KEEPALIVE_MARKER}${JSON.stringify(signal)}`;

export type SplitKeepaliveSignal = {
  /** The stream with every keepalive marker removed. What the user reads. */
  text: string;
  /** The last signal seen, or null. */
  signal: ChatStreamKeepaliveSignal | null;
};

/**
 * Separates keepalives from the answer.
 *
 * Tolerant in the same way and for the same reason as the routing-retry
 * splitter: a client running against a newer server may meet a payload it
 * cannot parse, and the failure that must never happen is showing the marker
 * and its JSON as the first words of an answer. An unparseable marker is
 * still removed; only its content is dropped.
 */
export const splitStreamKeepaliveSignal = (
  raw: string
): SplitKeepaliveSignal => {
  if (!raw.includes(STREAM_KEEPALIVE_MARKER)) return { text: raw, signal: null };

  let text = "";
  let signal: ChatStreamKeepaliveSignal | null = null;
  let rest = raw;

  for (;;) {
    const start = rest.indexOf(STREAM_KEEPALIVE_MARKER);
    if (start === -1) {
      text += rest;
      break;
    }
    text += rest.slice(0, start);
    const payloadStart = start + STREAM_KEEPALIVE_MARKER.length;
    const end = matchingBraceEnd(rest, payloadStart);
    if (end === -1) {
      // Half a marker: the stream is still arriving and the rest of this
      // object has not been read yet. Dropping it here is safe because the
      // caller re-splits the whole accumulation on every pass.
      break;
    }
    const parsed = parseSignal(rest.slice(payloadStart, end));
    if (parsed) signal = parsed;
    rest = rest.slice(end);
  }

  return { text, signal };
};

const matchingBraceEnd = (raw: string, from: number): number => {
  if (raw[from] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
};

const parseSignal = (payload: string): ChatStreamKeepaliveSignal | null => {
  try {
    const parsed = JSON.parse(payload) as Partial<ChatStreamKeepaliveSignal>;
    if (parsed?.state !== "awaiting_first_token" && parsed?.state !== "stalled") {
      return null;
    }
    return {
      state: parsed.state,
      elapsedMs:
        typeof parsed.elapsedMs === "number" && Number.isFinite(parsed.elapsedMs)
          ? parsed.elapsedMs
          : 0,
      ...(parsed.code === "CHAT_FIRST_RESPONSE_TIMEOUT"
        ? { code: parsed.code }
        : {}),
    };
  } catch {
    return null;
  }
};
