/**
 * DEFLATE and ZIP, inflated a little at a time, so a bomb stops part-way.
 *
 * Policy: docs/policy/chat-attachment-formats.md sections 2.5 and 4.6.
 *
 * fflate's one-shot calls (`inflateSync`, `unzipSync`, a single `push` of the
 * whole input) allocate the whole output before anyone sees it, so a byte
 * budget checked in a callback is checked after the memory is gone. And a ZIP
 * entry's sizes are the file's own claims: a section that says it is 1 KB can
 * inflate to a gigabyte.
 *
 * So the input goes in `INPUT_CHUNK` bytes at a time. DEFLATE expands by at
 * most about 1,032 times, which bounds one step's output to a few megabytes,
 * and `onChunk` -- which charges the caller's budget and throws to stop -- runs
 * after every step. The sizes that are checked are the bytes that actually
 * came out, never the ones the file declared.
 */

import { Inflate, Unzip, UnzipInflate } from "fflate";

/** Compressed bytes fed per step: at most ~4 MB of output before a check. */
export const INFLATE_INPUT_CHUNK = 4096;

export class BoundedInflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedInflateError";
  }
}

/**
 * Raw DEFLATE (no zlib header), chunk by chunk. `onChunk` sees every piece of
 * output as it is produced and may throw to stop; the pieces are joined only
 * after the stream ended within whatever bound `onChunk` enforces.
 */
export const inflateRawBounded = (
  data: Uint8Array,
  onChunk: (chunk: Uint8Array) => void
): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    onChunk(chunk);
    chunks.push(chunk);
    total += chunk.length;
  });
  for (let offset = 0; offset < data.length; offset += INFLATE_INPUT_CHUNK) {
    const end = Math.min(data.length, offset + INFLATE_INPUT_CHUNK);
    inflater.push(data.subarray(offset, end), end === data.length);
  }
  if (data.length === 0) inflater.push(new Uint8Array(0), true);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export type ZipEntryVisitor = {
  /** Called for every entry, read or not. Throw to refuse the package. */
  entry?: (name: string) => void;
  /** Whether to inflate this entry. Entries not accepted are never inflated. */
  accept: (name: string) => boolean;
  /**
   * Each piece of an accepted entry's output, as it is produced. `final` is
   * true on the entry's last piece (which may be empty). `index` numbers the
   * entries in order: a ZIP may hold two entries of one name, and anything
   * keyed by name alone would mix them.
   */
  data: (name: string, chunk: Uint8Array, final: boolean, index: number) => void;
};

/**
 * Walks a ZIP's entries in order, inflating the accepted ones a step at a
 * time. Throws `BoundedInflateError` for a ZIP this cannot read, and passes
 * through whatever a visitor throws.
 */
export const visitZipEntries = (bytes: Uint8Array, visitor: ZipEntryVisitor): void => {
  // The streaming reader skips bytes it does not recognise rather than
  // failing, so "is this a ZIP at all" is asked here: a local file header
  // first, and at least one entry by the end.
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new BoundedInflateError("Not a readable ZIP package.");
  }
  let entries = 0;
  // A visitor's own refusal (a budget, a bad path) is passed through as it
  // is; anything else that goes wrong is the ZIP's.
  let refusal: { error: unknown } | null = null;
  let damaged = false;
  const guard = (work: () => void) => {
    try {
      work();
    } catch (error) {
      refusal ??= { error };
      throw error;
    }
  };
  const unzip = new Unzip((file) => {
    const index = entries;
    entries += 1;
    guard(() => visitor.entry?.(file.name));
    if (!visitor.accept(file.name)) return;
    file.ondata = (error, chunk, final) => {
      if (error) {
        damaged = true;
        return;
      }
      guard(() => visitor.data(file.name, chunk, final, index));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += INFLATE_INPUT_CHUNK) {
      const end = Math.min(bytes.length, offset + INFLATE_INPUT_CHUNK);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
      if (damaged) break;
    }
  } catch {
    if (refusal) throw (refusal as { error: unknown }).error;
    throw new BoundedInflateError("Not a readable ZIP package.");
  }
  // fflate hands an exception thrown in `ondata` back to `ondata` as an
  // error, so a visitor's refusal can arrive here as "damaged"; the refusal
  // is the truer answer.
  if (refusal) throw (refusal as { error: unknown }).error;
  if (damaged || entries === 0) throw new BoundedInflateError("Not a readable ZIP package.");
};
