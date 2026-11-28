/**
 * "Read aloud" with the server's voice (POST /api/chat/readout), played in the
 * browser one piece at a time.
 *
 * Contract: docs/policy/voice-input.md §6.4. One answer at a time across both
 * engines: starting here stops the browser voice (lib/chatSpeech.ts) and any
 * other server read-aloud. When the server cannot read an answer before any of
 * it has played -- switched off, over its limit, provider failure -- the
 * caller's `onUnavailable` runs and the browser voice reads it instead.
 *
 * Nothing is retried. A failed request is not sent again; a piece that fails
 * after others have played ends the read-aloud.
 *
 * Audio already fetched is kept in memory per answer, so pressing "Read
 * aloud" again on the same answer replays it without buying it again.
 */

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

type Piece = { blob: Blob; chunks: number };

async function fetchPiece(messageId: string, cacheKey: string, index: number): Promise<Piece | null> {
  const cached = cache.get(cacheKey, index);
  if (cached && cached.chunks !== null) return { blob: cached.blob, chunks: cached.chunks };
  let response: Response;
  try {
    response = await fetch("/api/chat/readout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, chunk: index }),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const chunks = Number(response.headers.get("X-Readout-Chunks"));
  const blob = await response.blob().catch(() => null);
  if (!blob || !Number.isInteger(chunks) || chunks < 1) return null;
  cache.set(cacheKey, index, blob, chunks);
  return { blob, chunks };
}

/**
 * Starts reading one answer with the server voice. A second call for the
 * answer being read stops it instead.
 */
export function toggleReadout(input: { messageId: string; content: string; onUnavailable: () => void }) {
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

  const playFrom = async (index: number, total: number | null): Promise<void> => {
    const piece = await fetchPiece(input.messageId, cacheKey, index);
    if (generation !== mine) return;
    if (!piece) {
      stopReadout();
      // Only before anything was heard: a browser voice starting from the
      // top halfway through would repeat what was already read.
      if (index === 0) input.onUnavailable();
      return;
    }
    const count = total ?? piece.chunks;
    // Fetch the next piece while this one plays.
    if (index + 1 < count) void fetchPiece(input.messageId, cacheKey, index + 1);
    releaseUrl();
    objectUrl = URL.createObjectURL(piece.blob);
    element.onended = () => {
      if (generation !== mine) return;
      if (index + 1 < count) void playFrom(index + 1, count);
      else stopReadout();
    };
    element.onerror = () => {
      if (generation === mine) stopReadout();
    };
    element.src = objectUrl;
    try {
      await element.play();
      if (generation === mine && state?.phase !== "paused") {
        setState({ messageId: input.messageId, phase: "playing" });
      }
    } catch {
      if (generation === mine) {
        stopReadout();
        if (index === 0) input.onUnavailable();
      }
    }
  };
  void playFrom(0, null);
}
