/**
 * The reasoning summary of a Chat answer, as the browser sees it.
 *
 * A reasoning model thinks before it writes, and until its first visible token
 * the screen used to show nothing. When the provider sends a summary of that
 * thinking (OpenAI's reasoning summary, Anthropic's summarized thinking,
 * Google's thought summary) the server relays it here as an out-of-band chunk,
 * and the browser shows it above the answer and folds it into "Thought for N
 * seconds" once the answer starts.
 *
 * ## What this is not
 *
 * It is model output shown to the person who asked, and nothing else. It is
 * never part of the conversation sent back to the model, never part of a
 * share page, an export, a search index, a memory extraction or a branch copy:
 * the answer's `content` is the only text those read, and this travels beside
 * it. The persisted copy rides in the answer's existing JSON metadata
 * (`Message.searchMetadata.reasoning`), which no one of those paths reads;
 * `withoutStoredReasoning` is how a path that does copy that metadata drops it.
 *
 * ## Wire format
 *
 * Same convention as lib/chatStreamKeepalive.ts and lib/routingRetrySignal.ts:
 * a chunk led by a NUL code point, which providers do not emit in normal
 * completions, followed by one JSON object. A stream is not delivered in the
 * pieces it was written in, so the splitter finds the object's matching brace
 * and drops a truncated marker instead of rendering half of one.
 *
 *   {"state":"thinking"}                  thinking started, no text yet
 *   {"state":"thinking","text":"..."}     more summary text, to be appended
 *   {"state":"done","durationMs":12345}   the answer has started (or ended)
 *   {"state":"reset"}                     a fallback model took over; start over
 *
 * Every limit below is enforced on both sides: the server stops sending past
 * it and the browser stops accepting past it, because a client must not trust
 * a server it was not built together with.
 */

const NUL = String.fromCharCode(0);

/**
 * Sent by the web Chat client, which draws the summary. The server writes
 * reasoning chunks only to a request that names it, because an older client
 * (an installed app) reads an unknown NUL marker as "hold everything after it
 * back" and would show no answer at all.
 */
export const CHAT_REASONING_DISPLAY_HEADER = "X-Chat-Reasoning-Display";

export const CHAT_REASONING_MARKER = `${NUL}TOMVERSE_REASONING`;

/** Characters of summary kept: streamed, shown and stored. */
export const CHAT_REASONING_MAX_CHARACTERS = 8_000;

export type ChatReasoningSignal =
  | { state: "thinking"; text?: string }
  | { state: "done"; durationMs: number }
  | { state: "reset" };

/** What the answer card shows. */
export type ChatReasoningView = {
  /** The summary so far. Empty when the provider sent only that it is thinking. */
  text: string;
  /** False while the model is still thinking. */
  done: boolean;
  /** Time spent thinking, once known. */
  durationMs: number | null;
  /** The summary was longer than the limit and the rest was left out. */
  truncated: boolean;
};

export const buildChatReasoningChunk = (signal: ChatReasoningSignal): string =>
  `${CHAT_REASONING_MARKER}${JSON.stringify(signal)}`;

const boundedText = (text: string) => text.replaceAll(NUL, "");

const appendBounded = (view: ChatReasoningView, text: string): ChatReasoningView => {
  const clean = boundedText(text);
  if (!clean) return view;
  const room = CHAT_REASONING_MAX_CHARACTERS - view.text.length;
  if (room <= 0) return view.truncated ? view : { ...view, truncated: true };
  return clean.length > room
    ? { ...view, text: view.text + clean.slice(0, room), truncated: true }
    : { ...view, text: view.text + clean };
};

const finiteDuration = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 24 * 60 * 60 * 1000)
    : null;

export type SplitChatReasoning = {
  /** The stream with every reasoning marker removed. */
  text: string;
  /** What the markers add up to, or null when none arrived. */
  reasoning: ChatReasoningView | null;
  /** Complete markers removed, parseable or not. */
  count: number;
};

/**
 * Separates the reasoning markers from the rest and folds them into one view.
 *
 * Tolerant in the same way and for the same reason as the other splitters: a
 * marker this client cannot parse is still removed, so the failure that must
 * never happen -- the marker and its JSON read as the first words of an
 * answer -- cannot.
 */
export const splitChatReasoning = (raw: string): SplitChatReasoning => {
  if (!raw.includes(CHAT_REASONING_MARKER)) {
    return { text: raw, reasoning: null, count: 0 };
  }
  let text = "";
  let view = null as ChatReasoningView | null;
  let count = 0;
  let rest = raw;
  for (;;) {
    const start = rest.indexOf(CHAT_REASONING_MARKER);
    if (start === -1) {
      text += rest;
      break;
    }
    text += rest.slice(0, start);
    const payloadStart = start + CHAT_REASONING_MARKER.length;
    const end = matchingBraceEnd(rest, payloadStart);
    // Half a marker: the caller re-splits the whole accumulation each pass.
    if (end === -1) break;
    const signal = parseSignal(rest.slice(payloadStart, end));
    count += 1;
    rest = rest.slice(end);
    if (signal) view = applyReasoningSignal(view, signal);
  }
  return { text, reasoning: view, count };
};

const applyReasoningSignal = (
  view: ChatReasoningView | null,
  signal: ChatReasoningSignal
): ChatReasoningView | null => {
  if (signal.state === "reset") return null;
  if (signal.state === "thinking") {
    return appendBounded(
      { ...(view ?? { text: "", durationMs: null, truncated: false }), done: false },
      signal.text ?? ""
    );
  }
  return view ? { ...view, done: true, durationMs: signal.durationMs } : view;
};

/**
 * Folds one complete stream control into the view. For the stream reader that
 * meets each control once (`createChatStreamDisplayProjector().takeControls()`),
 * so the summary costs time linear in its length. A control that is not a
 * reasoning marker, or one this client cannot parse, leaves the view as it was.
 */
export const foldChatReasoningControl = (
  view: ChatReasoningView | null,
  control: string
): ChatReasoningView | null => {
  if (!control.startsWith(CHAT_REASONING_MARKER)) return view;
  const payloadStart = CHAT_REASONING_MARKER.length;
  const end = matchingBraceEnd(control, payloadStart);
  if (end === -1) return view;
  const signal = parseSignal(control.slice(payloadStart, end));
  return signal ? applyReasoningSignal(view, signal) : view;
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

const parseSignal = (payload: string): ChatReasoningSignal | null => {
  try {
    const parsed = JSON.parse(payload) as {
      state?: unknown;
      text?: unknown;
      durationMs?: unknown;
    } | null;
    if (parsed?.state === "reset") return { state: "reset" };
    if (parsed?.state === "thinking") {
      return typeof parsed.text === "string" && parsed.text
        ? { state: "thinking", text: parsed.text }
        : { state: "thinking" };
    }
    if (parsed?.state === "done") {
      const durationMs = finiteDuration(parsed.durationMs);
      return durationMs === null ? null : { state: "done", durationMs };
    }
    return null;
  } catch {
    return null;
  }
};

/* ---- the persisted copy ---------------------------------------------- */

/** The shape written into `Message.searchMetadata.reasoning`. */
export type StoredChatReasoning = {
  text: string;
  durationMs?: number;
  truncated?: true;
};

export const storedChatReasoning = (input: {
  text: string;
  durationMs: number | null;
  truncated: boolean;
}): StoredChatReasoning => ({
  text: boundedText(input.text).slice(0, CHAT_REASONING_MAX_CHARACTERS),
  ...(input.durationMs !== null ? { durationMs: input.durationMs } : {}),
  ...(input.truncated ? { truncated: true as const } : {}),
});

/** `searchMetadata` with the reasoning copy added; unchanged when there is none. */
export const withStoredReasoning = <T extends object | null | undefined>(
  searchMetadata: T,
  reasoning: StoredChatReasoning | null
): T | (T & { reasoning: StoredChatReasoning }) =>
  reasoning ? { ...(searchMetadata ?? {}), reasoning } as T & { reasoning: StoredChatReasoning } : searchMetadata;

/**
 * The persisted reasoning of a message, read defensively: the column is JSON a
 * newer or older build wrote, so nothing about its shape is assumed.
 */
export const readStoredChatReasoning = (searchMetadata: unknown): ChatReasoningView | null => {
  if (!searchMetadata || typeof searchMetadata !== "object" || Array.isArray(searchMetadata)) return null;
  const stored = (searchMetadata as { reasoning?: unknown }).reasoning;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const { text, durationMs, truncated } = stored as {
    text?: unknown;
    durationMs?: unknown;
    truncated?: unknown;
  };
  if (typeof text !== "string") return null;
  const clean = boundedText(text);
  const bounded = clean.slice(0, CHAT_REASONING_MAX_CHARACTERS);
  return {
    text: bounded,
    done: true,
    durationMs: finiteDuration(durationMs),
    truncated: truncated === true || bounded.length < clean.length,
  };
};

/**
 * `searchMetadata` without the reasoning copy. For every path that carries a
 * message's metadata somewhere the reasoning must not go: the request
 * transcript sent back to the server, a copy of the conversation.
 */
export const withoutStoredReasoning = <T>(searchMetadata: T): T => {
  if (!searchMetadata || typeof searchMetadata !== "object" || Array.isArray(searchMetadata)) {
    return searchMetadata;
  }
  if (!("reasoning" in searchMetadata)) return searchMetadata;
  const rest = { ...(searchMetadata as Record<string, unknown>) };
  delete rest.reasoning;
  return rest as T;
};
