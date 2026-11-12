/**
 * What a package really expands to, containers inside it included.
 *
 * Policy: docs/policy/chat-attachment-formats.md section 2.5 and
 * docs/policy/generated-artifacts.md section 15.3.
 *
 * Counting a ZIP's entries is not enough when an entry is itself compressed
 * and the reader on the other side opens it: an iWork package's
 * `index.xml.gz` or `Index.zip`, a workbook embedded in a Word file, and the
 * Snappy-compressed `.iwa` records of every modern iWork document. Each is
 * measured here against the *same* running total:
 *
 *   * a nested ZIP is walked the same way, to a fixed depth;
 *   * a gzip member is inflated a step at a time, its output counted and
 *     dropped;
 *   * an `.iwa` record's Snappy block states its uncompressed length up front,
 *     and a Snappy decoder writes no more than that, so the stated lengths are
 *     the bound -- summed, not trusted to be small.
 *
 * Every byte counted is a byte that really came out of a decoder, or one a
 * decoder is bounded by. A total past the ceiling stops the walk part-way.
 */

import { Gunzip } from "fflate";

import {
  BoundedInflateError,
  INFLATE_INPUT_CHUNK,
  visitZipEntries,
} from "@/lib/boundedInflate";

export class ExpansionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpansionLimitError";
  }
}

export type ExpansionCounter = {
  add: (bytes: number) => void;
  readonly total: () => number;
};

export const createExpansionCounter = (maxBytes: number): ExpansionCounter => {
  let total = 0;
  return {
    add: (bytes) => {
      total += bytes;
      if (total > maxBytes) throw new ExpansionLimitError("Expands too far.");
    },
    total: () => total,
  };
};

/** How deep containers may nest inside one another before the package is refused. */
export const MAX_NESTED_CONTAINER_DEPTH = 3;

const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const isGzip = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** A gzip member inflated a step at a time; every piece goes to `onChunk`. */
export const gunzipBounded = (data: Uint8Array, onChunk: (chunk: Uint8Array) => void): void => {
  const gunzip = new Gunzip((chunk) => onChunk(chunk));
  for (let offset = 0; offset < data.length; offset += INFLATE_INPUT_CHUNK) {
    const end = Math.min(data.length, offset + INFLATE_INPUT_CHUNK);
    gunzip.push(data.subarray(offset, end), end === data.length);
  }
};

/**
 * The uncompressed lengths an `.iwa` record states, summed.
 *
 * IWA framing: chunks of [type byte 0][3-byte little-endian length][Snappy
 * block]; a Snappy block opens with its uncompressed length as a varint.
 */
const iwaStatedLength = (data: Uint8Array): number => {
  let total = 0;
  let offset = 0;
  while (offset + 4 <= data.length) {
    const length = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16);
    const start = offset + 4;
    let value = 0;
    let shift = 0;
    for (let index = start; index < Math.min(start + 5, data.length); index += 1) {
      value += (data[index] & 0x7f) * 2 ** shift;
      shift += 7;
      if ((data[index] & 0x80) === 0) break;
    }
    total += value;
    offset = start + length;
  }
  return total;
};

type Nested = { kind: "zip" | "gzip" | "iwa"; chunks: Uint8Array[] };

const join = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export type PackageVisitor = {
  /** Every entry name, at every depth. Throw to refuse the package. */
  entry?: (name: string, depth: number) => void;
};

/**
 * Walks a ZIP package and everything compressed inside it, charging every
 * byte to `counter`. Throws `ExpansionLimitError` past the counter's ceiling
 * or past `MAX_NESTED_CONTAINER_DEPTH`, `BoundedInflateError` for a package
 * that is not a readable ZIP, and passes through what `visitor` throws.
 */
export const measurePackage = (
  bytes: Uint8Array,
  counter: ExpansionCounter,
  visitor: PackageVisitor = {},
  depth = 0
): void => {
  if (depth > MAX_NESTED_CONTAINER_DEPTH) {
    throw new ExpansionLimitError("Containers nest too deeply.");
  }
  // Entries whose first bytes say they are a container, or whose name says
  // they are an IWA record, are kept -- they were counted already -- to be
  // measured once their own entry has ended.
  // Keyed by the entry's position, not its name: two entries may share one.
  const nested = new Map<number, Nested & { name: string }>();
  /** Entries still gathering the bytes their kind is decided by. */
  const pending = new Map<number, Uint8Array[]>();
  const decided = new Set<number>();
  visitZipEntries(bytes, {
    entry: (name) => visitor.entry?.(name, depth),
    accept: () => true,
    data: (name, chunk, final, index) => {
      counter.add(chunk.length);
      const kept = nested.get(index);
      if (kept) {
        kept.chunks.push(chunk);
        return;
      }
      if (decided.has(index)) return;
      // The signature is read from the entry's first four bytes, gathered
      // across however many pieces they arrive in: a piece can be one byte,
      // and deciding on it would let a container through unmeasured.
      const gathered = pending.get(index) ?? [];
      gathered.push(chunk);
      const head = join(gathered);
      if (head.length < 4 && !final) {
        pending.set(index, gathered);
        return;
      }
      pending.delete(index);
      decided.add(index);
      const first = head.subarray(0, 4);
      const kind = /\.iwa$/i.test(name)
        ? "iwa"
        : isZip(first)
          ? "zip"
          : isGzip(first)
            ? "gzip"
            : null;
      if (kind) nested.set(index, { kind, chunks: [head], name });
    },
  });

  for (const { name, kind, chunks } of nested.values()) {
    const inner = join(chunks);
    if (kind === "zip") {
      measurePackage(inner, counter, {
        entry: (entry, at) => visitor.entry?.(`${name}/${entry}`, at),
      }, depth + 1);
    } else if (kind === "gzip") {
      try {
        gunzipBounded(inner, (chunk) => counter.add(chunk.length));
      } catch (error) {
        if (error instanceof ExpansionLimitError) throw error;
        throw new BoundedInflateError("A compressed member is not readable.");
      }
    } else {
      counter.add(iwaStatedLength(inner));
    }
  }
};
