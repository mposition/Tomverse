/**
 * "Read aloud" with the server's voice (POST /api/chat/readout), played in the
 * browser one piece at a time.
 *
 * Contract: docs/policy/voice-input.md §6.4. One answer at a time across both
 * engines: starting here stops the browser voice (lib/chatSpeech.ts) and any
 * other server read-aloud. When the server cannot read a piece -- switched
 * off, over its limit, provider failure -- the browser voice reads the answer
 * from that piece on (the whole answer when nothing had played yet).
 *
 * Nothing is retried. Each piece has one request at a time, shared by the
 * prefetch and the playback; a piece whose outcome is unknown is never asked
 * for again on this page (createReadoutPieceRequester). The server holds the
 * same line on its side with a per-piece lease.
 *
 * Audio already fetched is kept in memory per answer, so pressing "Read
 * aloud" again on the same answer replays it without buying it again.
 */

import { readoutPieces } from "@/lib/chatReadoutText";
import { stopSpeaking } from "@/lib/chatSpeech";

export type ReadoutPhase = "loading" | "playing" | "paused";
export type ReadoutState = { messageId: string; phase: ReadoutPhase } | null;

type CachedAnswer = { chunks: number | null; pieces: Map<number, Blob> };

/** A small per-answer cache, oldest answer evicted first. Pure, so it is testable without a browser. */
export function createReadoutAudioCache(maxAnswers = 4) {
  const answers = new Map<string, CachedAnswer>();
  const touch = (key: string) => {
    const entry = answers.get(key);
    if (!entry) return undefined;
    answers.delete(key);
    answers.set(key, entry);
    return entry;
  };
  return {
    get(key: string, index: number): { blob: Blob; chunks: number | null } | null {
      const entry = touch(key);
      const blob = entry?.pieces.get(index);
      return entry && blob ? { blob, chunks: entry.chunks } : null;
    },
    set(key: string, index: number, blob: Blob, chunks: number) {
      const entry = touch(key) ?? { chunks: null, pieces: new Map<number, Blob>() };
      entry.chunks = chunks;
      entry.pieces.set(index, blob);
      answers.set(key, entry);
      while (answers.size > maxAnswers) {
        const oldest = answers.keys().next().value;
        if (oldest === undefined) break;
        answers.delete(oldest);
      }
    },
    keys: () => [...answers.keys()],
  };
}

/** Same answer, same text: a changed answer is a different cache entry. */
export function readoutCacheKey(messageId: string, content: string) {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) hash = (hash * 31 + content.charCodeAt(index)) | 0;
  return `${messageId}:${content.length}:${hash >>> 0}`;
}

let state: ReadoutState = null;
let generation = 0;
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
const listeners = new Set<() => void>();
const cache = createReadoutAudioCache();

// A 44-byte silent WAV. Started inside the click so the element is allowed to
// play later, after the first piece arrives (Safari's gesture rule).
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

const emit = () => {
  for (const listener of listeners) listener();
};
const setState = (next: ReadoutState) => {
  state = next;
  emit();
};

export const getReadoutState = () => state;
export const subscribeReadout = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const releaseUrl = () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
};

export function stopReadout() {
  generation += 1;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
  }
  releaseUrl();
  if (state !== null) setState(null);
}

export function pauseReadout() {
  if (state?.phase !== "playing" || !audio) return;
  audio.pause();
  setState({ ...state, phase: "paused" });
}

export function resumeReadout() {
  if (state?.phase !== "paused" || !audio) return;
  void audio.play().catch(() => stopReadout());
  setState({ ...state, phase: "playing" });
}

export type PieceResult =
  | { ok: true; blob: Blob; chunks: number }
  /** `unknown`: the paid call may have been made and billed; never asked for again. */
  | { ok: false; unknown: boolean };

/**
 * Failures that cost nothing: the server refused before the provider, or the
 * provider refused. Everything else -- an unknown provider outcome, a server
 * error, an unreadable answer -- may have been billed.
 */
const NOT_BILLED_CODES = new Set([
  "READOUT_UNAVAILABLE",
  "READOUT_AUTH_REQUIRED",
  "READOUT_NOT_AN_ANSWER",
  "READOUT_NOTHING_TO_READ",
  "READOUT_LIMIT_REACHED",
  "READOUT_IN_PROGRESS",
  "READOUT_PROVIDER_REFUSED",
  "CONVERSATION_LOCKED",
  "API_RATE_LIMITED",
]);

export const readoutFailureIsUnknown = (status: number, code: unknown) =>
  !(typeof code === "string" && NOT_BILLED_CODES.has(code)) && (status >= 500 || status === 0);

/**
 * One request per piece, shared. Asking for a piece that is already being
 * fetched -- the prefetch during the previous piece, then playback reaching
 * it -- waits for that request instead of starting another. A piece whose
 * outcome is unknown is remembered for the rest of the page's life and is not
 * requested again: re-asking could buy it a second time. A refusal is not
 * remembered; it cost nothing. Exported as a factory so a test can drive it
 * with its own `fetch`.
 */
export function createReadoutPieceRequester(input: {
  fetchImpl: typeof fetch;
  cache: ReturnType<typeof createReadoutAudioCache>;
}) {
  const inflight = new Map<string, Promise<PieceResult>>();
  const unknown = new Set<string>();

  const fetchOnce = async (messageId: string, cacheKey: string, index: number): Promise<PieceResult> => {
    let response: Response;
    try {
      response = await input.fetchImpl("/api/chat/readout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, chunk: index }),
        cache: "no-store",
      });
    } catch {
      // The request may have reached the server and the provider.
      return { ok: false, unknown: true };
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      return { ok: false, unknown: readoutFailureIsUnknown(response.status, body?.code) };
    }
    const chunks = Number(response.headers.get("X-Readout-Chunks"));
    const blob = await response.blob().catch(() => null);
    // Answered, so billed -- but lost on the way. Asking again would buy it again.
    if (!blob || !Number.isInteger(chunks) || chunks < 1) return { ok: false, unknown: true };
    input.cache.set(cacheKey, index, blob, chunks);
    return { ok: true, blob, chunks };
  };

  return (messageId: string, cacheKey: string, index: number): Promise<PieceResult> => {
    const cached = input.cache.get(cacheKey, index);
    if (cached && cached.chunks !== null) return Promise.resolve({ ok: true, blob: cached.blob, chunks: cached.chunks });
    const id = `${cacheKey}#${index}`;
    if (unknown.has(id)) return Promise.resolve({ ok: false, unknown: true });
    const pending = inflight.get(id);
    if (pending) return pending;
    const request = fetchOnce(messageId, cacheKey, index).then((result) => {
      if (!result.ok && result.unknown) unknown.add(id);
      inflight.delete(id);
      return result;
    });
    inflight.set(id, request);
    return request;
  };
}

const requestPiece = createReadoutPieceRequester({
  fetchImpl: (...args) => fetch(...args),
  cache,
});

/**
 * Starts reading one answer with the server voice. A second call for the
 * answer being read stops it instead.
 *
 * When a piece cannot be had from the server, the server voice stops and
 * `onUnavailable` receives the text from that piece on, so the browser voice
 * continues where the server voice ended -- the whole answer when nothing had
 * played yet. The unavailable piece is not requested again.
 */
export function toggleReadout(input: { messageId: string; content: string; onUnavailable: (text: string) => void }) {
  if (state?.messageId === input.messageId) {
    stopReadout();
    return;
  }
  stopSpeaking();
  stopReadout();
  const mine = ++generation;
  const element = (audio ??= new Audio());
  element.src = SILENT_WAV;
  void element.play().catch(() => undefined);
  setState({ messageId: input.messageId, phase: "loading" });
  const cacheKey = readoutCacheKey(input.messageId, input.content);

  // The same pieces the server cuts (lib/chatReadoutText.ts), so the browser
  // voice can pick up exactly where the server voice stopped.
  const continueInBrowser = (index: number) => {
    stopReadout();
    const text = index === 0 ? input.content : readoutPieces(input.content).chunks.slice(index).join("\n");
    if (text.trim()) input.onUnavailable(text);
  };

  const playFrom = async (index: number, total: number | null): Promise<void> => {
    const piece = await requestPiece(input.messageId, cacheKey, index);
    if (generation !== mine) return;
    if (!piece.ok) {
      continueInBrowser(index);
      return;
    }
    const count = total ?? piece.chunks;
    // Fetch the next piece while this one plays; playback reaching it waits
    // for this same request.
    if (index + 1 < count) void requestPiece(input.messageId, cacheKey, index + 1);
    releaseUrl();
    objectUrl = URL.createObjectURL(piece.blob);
    element.onended = () => {
      if (generation !== mine) return;
      if (index + 1 < count) void playFrom(index + 1, count);
      else stopReadout();
    };
    // The audio could not be played (a decode error, say). The piece was
    // already bought, so it is not asked for again: the browser voice reads on
    // from this piece instead.
    element.onerror = () => {
      if (generation === mine) continueInBrowser(index);
    };
    element.src = objectUrl;
    try {
      await element.play();
      if (generation === mine && state?.phase !== "paused") {
        setState({ messageId: input.messageId, phase: "playing" });
      }
    } catch {
      if (generation === mine) continueInBrowser(index);
    }
  };
  void playFrom(0, null);
}
