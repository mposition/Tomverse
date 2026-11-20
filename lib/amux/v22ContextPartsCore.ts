/**
 * The context files that go down to the box in chunks instead of inside the
 * delivery prompt (docs/policy/amux-v22-result-transfer.md 10.1, owner
 * direction 2026-11-19: no size bound of ours on what a card run is given).
 * `prior.patch` and `prior-conclusions.md` are the two files with no size set
 * by their source; the app rebuilds the same bytes for every chunk request and
 * the box checks the whole against the sha256 the pull named.
 *
 * Pure: plain TypeScript with no imports beyond node: and sibling cores, so
 * the delivery, the chunk route and the tests read the one copy.
 */

import { createHash } from "node:crypto";

import { AMUX_V22_CONTEXT_FILES, type AmuxV22ContextFile } from "./v22LocalCliFlowCore.ts";
import { amuxV22TransferChunkCount, amuxV22TransferChunkRange } from "./v22TransferCore.ts";

/** The header a bridge sends on a delivery pull to say what it can receive. */
export const AMUX_BRIDGE_FEATURES_HEADER = "x-amux-bridge-features";
/** The bridge fetches the chunked context files and hands them to the sidecar. */
export const AMUX_BRIDGE_CONTEXT_CHUNKS_FEATURE = "context_chunks";

/** Whether a comma-separated features header names `feature`. */
export const amuxBridgeFeatureListed = (header: string | null | undefined,
  feature: string): boolean =>
  typeof header === "string" && header.split(",").some((token) => token.trim() === feature);

/** The context files that travel as chunks when the bridge can take them. */
export const AMUX_V22_CONTEXT_PART_NAMES = [
  AMUX_V22_CONTEXT_FILES.priorPatch,
  AMUX_V22_CONTEXT_FILES.priorConclusions,
] as const;
export type AmuxV22ContextPartName = (typeof AMUX_V22_CONTEXT_PART_NAMES)[number];

export const isAmuxV22ContextPartName = (name: unknown): name is AmuxV22ContextPartName =>
  typeof name === "string" && (AMUX_V22_CONTEXT_PART_NAMES as readonly string[]).includes(name);

/** What a pull says of one chunked file: its UTF-8 byte count and sha256. */
export type AmuxV22ContextPart = { name: string; bytes: number; sha256: string };

const bytesOf = (text: string): Buffer => Buffer.from(text, "utf8");

/**
 * The files a delivery embeds in its prompt and the parts it names instead.
 * Without the feature every file is embedded, as before. The prompt's list of
 * files (`amuxV22ContextPromptSection`) is built from the whole set by the
 * caller, so the worker is told about every file either way.
 */
export function splitAmuxV22ContextFiles(files: readonly AmuxV22ContextFile[],
  chunked: boolean): { embedded: AmuxV22ContextFile[]; parts: AmuxV22ContextPart[] } {
  if (!chunked) return { embedded: [...files], parts: [] };
  const embedded: AmuxV22ContextFile[] = [];
  const parts: AmuxV22ContextPart[] = [];
  for (const file of files) {
    const bytes = bytesOf(file.text);
    if (!isAmuxV22ContextPartName(file.name) || bytes.length === 0) {
      embedded.push(file);
      continue;
    }
    parts.push({ name: file.name, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { embedded, parts };
}

/**
 * One chunk of a chunked file's text. Throws RangeError for an index outside
 * the file (the route answers 400).
 */
export function amuxV22ContextChunk(text: string, index: number): {
  totalBytes: number; chunkCount: number; sha256: string; bytes: Buffer;
} {
  const all = bytesOf(text);
  const range = amuxV22TransferChunkRange(all.length, index);
  return { totalBytes: all.length, chunkCount: amuxV22TransferChunkCount(all.length),
    sha256: createHash("sha256").update(all).digest("hex"),
    bytes: all.subarray(range.start, range.end) };
}
