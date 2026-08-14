/**
 * §7's `retrying_with_another_model`, as a chunk in the answer stream.
 *
 * ## Why it is in the stream and not a header
 *
 * A fallback is decided after the provider has already been asked, and the
 * response's headers are fixed before any body byte goes out. The only way to
 * make the retry known before headers would be to hold them until the first
 * token arrives -- which would add the provider's whole time-to-first-token to
 * every response, routed or not, and TTFT is the thing `ROUTE-02` and
 * `ROUTE-03` are gates on. Trading a measured budget for an unmeasured one is
 * the wrong direction, so the signal goes where the news is: in the stream.
 *
 * It reuses `lib/webSearchStreamTrailer.ts`'s convention -- a chunk led by a
 * NUL code point, which providers do not emit in normal completions, so real
 * model output cannot collide with it. Unlike that one this is a *leading*
 * chunk: it is emitted before any answer text, because by §7 it may only be
 * sent while nothing has been shown.
 *
 * ## What it deliberately does not carry
 *
 * The provider's error. §7: the retry is announced "without exposing internal
 * provider errors". A user is told their answer is coming from a different
 * model; they are not shown a stack trace from a vendor, and support is not
 * given a reason to quote one back.
 */

const NUL = String.fromCharCode(0);

export const ROUTING_RETRY_MARKER = `${NUL}TOMVERSE_ROUTING_RETRY`;

export type RoutingRetrySignal = {
  /** §7's own name for the state. Fixed, so a client can switch on it. */
  state: "retrying_with_another_model";
  /** The model now answering. A model id, never a provider error. */
  modelId: string;
};

export const buildRoutingRetryChunk = (modelId: string): string =>
  `${ROUTING_RETRY_MARKER}${JSON.stringify({
    state: "retrying_with_another_model",
    modelId,
  } satisfies RoutingRetrySignal)}`;

export type SplitRetrySignal = {
  /** The stream with any retry signal removed. What the user reads. */
  text: string;
  /** The last signal seen, or null. */
  signal: RoutingRetrySignal | null;
};

/**
 * Separates the signal from the answer.
 *
 * Tolerant on purpose. A client running against a newer server may meet a
 * marker it cannot parse, and the failure that must not happen is rendering
 * `\u0000TOMVERSE_ROUTING_RETRY{...}` as the first words of an answer.
 * So an unparseable signal is still *removed*; only its content is dropped.
 */
export const splitRoutingRetrySignal = (raw: string): SplitRetrySignal => {
  if (!raw.includes(ROUTING_RETRY_MARKER)) return { text: raw, signal: null };

  let text = "";
  let signal: RoutingRetrySignal | null = null;
  let rest = raw;

  for (;;) {
    const start = rest.indexOf(ROUTING_RETRY_MARKER);
    if (start === -1) {
      text += rest;
      break;
    }
    text += rest.slice(0, start);
    const payloadStart = start + ROUTING_RETRY_MARKER.length;
    // The payload is one JSON object and the answer follows it immediately,
    // so the end is the matching brace rather than the end of the chunk --
    // a stream is not delivered in the pieces it was written in.
    const end = matchingBraceEnd(rest, payloadStart);
    if (end === -1) {
      // A truncated signal: drop what is left rather than show it. The stream
      // is still arriving, and half a marker is not answer text.
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

const parseSignal = (payload: string): RoutingRetrySignal | null => {
  try {
    const parsed = JSON.parse(payload) as Partial<RoutingRetrySignal>;
    return parsed?.state === "retrying_with_another_model" &&
      typeof parsed.modelId === "string" &&
      parsed.modelId !== ""
      ? { state: parsed.state, modelId: parsed.modelId }
      : null;
  } catch {
    return null;
  }
};
