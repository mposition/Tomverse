import { READOUT_CHUNK_MAX_CHARACTERS, READOUT_MAX_CHUNKS } from "@/lib/chatReadoutAccess";
import { plainTextForSpeech, splitSpeechChunks } from "@/lib/chatSpeechText";

/**
 * The pieces a server read-aloud sends to the speech provider, one request
 * each. Pure and deterministic: the route recomputes them from the stored
 * answer on every request, so piece `n` is the same text every time it is
 * asked for, and the browser never supplies the text that is billed.
 *
 * The same cleaning as the browser voice (lib/chatSpeechText.ts): no code
 * blocks (Mermaid and chart blocks included), tables, formulas or link
 * addresses. Sentences are packed up to the piece size rather than sent one
 * by one, so a long answer is a handful of requests, not dozens.
 */
export type ReadoutPieces = {
  chunks: string[];
  /** True when the answer was longer than the cap and its end is not read. */
  truncated: boolean;
};

export function readoutPieces(
  markdown: string,
  limits: { maxCharacters: number; maxChunks: number } = {
    maxCharacters: READOUT_CHUNK_MAX_CHARACTERS,
    maxChunks: READOUT_MAX_CHUNKS,
  }
): ReadoutPieces {
  const sentences = splitSpeechChunks(plainTextForSpeech(markdown), limits.maxCharacters);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const joined = current ? `${current}\n${sentence}` : sentence;
    if (joined.length <= limits.maxCharacters) {
      current = joined;
      continue;
    }
    if (current) chunks.push(current);
    current = sentence;
  }
  if (current) chunks.push(current);
  return {
    chunks: chunks.slice(0, limits.maxChunks),
    truncated: chunks.length > limits.maxChunks,
  };
}
