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

import { Inflate } from "fflate";

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

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_MARKER = 0xffffffff;

const unreadable = () => new BoundedInflateError("Not a readable ZIP package.");

type CentralEntry = {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
};

const decodeName = (bytes: Uint8Array, utf8: boolean) =>
  utf8 ? new TextDecoder("utf-8").decode(bytes) : String.fromCharCode(...bytes);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const containsLocalHeader = (bytes: Uint8Array, start: number, end: number) => {
  for (let index = start; index + 4 <= end; index += 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x03 && bytes[index + 3] === 0x04) {
      return true;
    }
  }
  return false;
};

/**
 * The package's entries as its central directory lists them, each checked
 * against the local header it points at.
 *
 * Readers disagree on which of the two to believe: a streaming reader walks
 * local headers, LibreOffice and most libraries read the central directory.
 * A package where the two tell different stories -- a local header that says
 * "stored, 0 bytes" over a DEFLATE bomb the central directory lists in full,
 * or a local entry the central directory never mentions -- would be measured
 * as one thing and opened as another. So both must agree, and the region
 * before the central directory may hold no local header the directory does
 * not account for.
 */
const readCentralDirectory = (bytes: Uint8Array): { entries: CentralEntry[]; dataEnd: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 22 bytes plus a comment of at most 64 KB;
  // the comment must run exactly to the end of the file, so there is one
  // candidate only.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL && at + 22 + view.getUint16(at + 20, true) === bytes.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw unreadable();
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0 || view.getUint16(eocd + 8, true) !== count) throw unreadable();
  if (count === 0xffff || cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) throw unreadable();
  if (cdOffset + cdSize !== eocd) throw unreadable();

  const entries: CentralEntry[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL_HEADER) throw unreadable();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw unreadable();
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || offset === ZIP64_MARKER) throw unreadable();
    // Encrypted entries and methods other than stored and DEFLATE are ones no
    // office reader opens; they are refused rather than skipped.
    if ((flags & 0x1) !== 0 || (method !== 0 && method !== 8)) throw unreadable();
    if (method === 0 && compressedSize !== size) throw unreadable();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    entries.push({
      name: decodeName(nameBytes, (flags & 0x800) !== 0),
      nameBytes,
      flags,
      method,
      compressedSize,
      size,
      offset,
    });
    at = end;
  }
  if (at !== eocd || entries.length === 0) throw unreadable();
  return { entries, dataEnd: cdOffset };
};

/** Where an entry's compressed data starts, once its local header agrees with the directory. */
const checkLocalHeader = (bytes: Uint8Array, entry: CentralEntry, dataEnd: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (at + 30 > dataEnd || view.getUint32(at, true) !== LOCAL_HEADER) throw unreadable();
  const flags = view.getUint16(at + 6, true);
  const method = view.getUint16(at + 8, true);
  const compressedSize = view.getUint32(at + 18, true);
  const size = view.getUint32(at + 22, true);
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  if (method !== entry.method || (flags & 0x1) !== (entry.flags & 0x1)) throw unreadable();
  // With a trailing data descriptor (flag bit 3) the local sizes may be zero;
  // otherwise they are the central directory's, exactly.
  const deferred = (flags & 0x8) !== 0;
  if (!(deferred && compressedSize === 0 && size === 0)) {
    if (compressedSize !== entry.compressedSize || size !== entry.size) throw unreadable();
  }
  if (!sameBytes(bytes.subarray(at + 30, at + 30 + nameLength), entry.nameBytes)) throw unreadable();
  const start = at + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > dataEnd) throw unreadable();
  return start;
};

/**
 * Walks a ZIP's entries in the central directory's order, inflating the
 * accepted ones a step at a time. Throws `BoundedInflateError` for a ZIP this
 * cannot read -- including one whose local headers and central directory
 * disagree -- and passes through whatever a visitor throws.
 */
export const visitZipEntries = (bytes: Uint8Array, visitor: ZipEntryVisitor): void => {
  if (bytes.length < 4 || new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) !== LOCAL_HEADER) {
    throw unreadable();
  }
  const { entries, dataEnd } = readCentralDirectory(bytes);

  // Every entry's data, located and checked before anything is inflated, and
  // the gaps between them free of local headers the directory does not list.
  const spans = entries
    .map((entry, index) => ({ index, start: entry.offset, dataStart: checkLocalHeader(bytes, entry, dataEnd) }))
    .map((span) => ({ ...span, end: span.dataStart + entries[span.index].compressedSize }))
    .sort((a, b) => a.start - b.start);
  if (spans[0].start !== 0) throw unreadable();
  for (let index = 0; index < spans.length; index += 1) {
    const next = index + 1 < spans.length ? spans[index + 1].start : dataEnd;
    if (next < spans[index].end) throw unreadable();
    if (containsLocalHeader(bytes, spans[index].end, next)) throw unreadable();
  }
  const dataStart = new Map(spans.map((span) => [span.index, span.dataStart]));

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    visitor.entry?.(entry.name);
    if (!visitor.accept(entry.name)) continue;
    const start = dataStart.get(index) as number;
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) {
      for (let offset = 0; offset < data.length; offset += INFLATE_INPUT_CHUNK) {
        const end = Math.min(data.length, offset + INFLATE_INPUT_CHUNK);
        visitor.data(entry.name, data.subarray(offset, end), end === data.length, index);
      }
      if (data.length === 0) visitor.data(entry.name, new Uint8Array(0), true, index);
      continue;
    }
    // A visitor's own refusal (a budget, a bad path) is passed through as it
    // is; anything else that goes wrong is the ZIP's.
    let refusal: { error: unknown } | null = null;
    let produced = 0;
    let ended = false;
    const inflater = new Inflate((chunk, final) => {
      produced += chunk.length;
      ended ||= final;
      try {
        visitor.data(entry.name, chunk, final, index);
      } catch (error) {
        refusal ??= { error };
        throw error;
      }
    });
    try {
      for (let offset = 0; offset < data.length; offset += INFLATE_INPUT_CHUNK) {
        const end = Math.min(data.length, offset + INFLATE_INPUT_CHUNK);
        inflater.push(data.subarray(offset, end), end === data.length);
      }
      if (data.length === 0) inflater.push(new Uint8Array(0), true);
    } catch {
      if (refusal) throw (refusal as { error: unknown }).error;
      throw unreadable();
    }
    // The stream must end, and at the size the directory states: a reader
    // that sizes its buffer from the directory must not meet different data.
    if (!ended || produced !== entry.size) throw unreadable();
  }
};
