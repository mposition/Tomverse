/**
 * The v22 result transfer in parts (docs/policy/amux-v22-result-transfer.md,
 * owner direction 2026-11-18: no size bound of ours on a run's result, patch
 * or changed-path list). A part goes from the box to the app as fixed-size
 * chunks; the chunk size is what one request can carry, never a bound on the
 * content. Plain TypeScript with no imports beyond node:, so the sidecar
 * bundle, the app and the tests all read the one copy. The Rust bridge keeps
 * the same values (apps/tomverse-orchestrator/src/tomverse_api.rs), and
 * tests/amuxV22PatchLimit.test.mjs holds the two equal.
 */

/** The bytes of one chunk (the last chunk of a part is shorter). */
export const AMUX_V22_TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;

/** The parts a run's result travels as. */
export const AMUX_V22_TRANSFER_PARTS = ["result", "patch", "changed_paths"] as const;
export type AmuxV22TransferPart = (typeof AMUX_V22_TRANSFER_PARTS)[number];

/** One chunk request: base64 of a full chunk (5,592,408) plus its envelope. */
export const AMUX_V22_TRANSFER_BODY_MAX_BYTES = 6 * 1024 * 1024;

/** Next.js proxyClientMaxBodySize default: an external bound on one request. */
export const AMUX_V22_PROXY_BODY_MAX_BYTES = 10 * 1024 * 1024;

/** One Postgres value holds 1 GB (external); the seal needs a little room. */
export const AMUX_V22_STORAGE_MAX_BYTES = 1_073_741_823 - 65_536;

/** The sha256 of no bytes: the digest of an empty changed-path list. */
export const AMUX_V22_EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** How many chunks a part of `total` bytes travels as (0 for no bytes). */
export const amuxV22TransferChunkCount = (total: number): number => {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("invalid transfer size");
  }
  return Math.ceil(total / AMUX_V22_TRANSFER_CHUNK_BYTES);
};

/** The byte range [start, end) of chunk `index` of a part of `total` bytes. */
export const amuxV22TransferChunkRange = (
  total: number,
  index: number,
): { start: number; end: number } => {
  const count = amuxV22TransferChunkCount(total);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError("invalid transfer chunk index");
  }
  const start = index * AMUX_V22_TRANSFER_CHUNK_BYTES;
  return { start, end: Math.min(total, start + AMUX_V22_TRANSFER_CHUNK_BYTES) };
};

/**
 * Time in proportion to size: one second per chunk's worth of bytes (4 MiB a
 * second is taken as the slowest throughput). Every size-dependent timeout of
 * the transfer adds this and nothing else.
 */
export const amuxV22SizeAllowanceMs = (bytes: number): number => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / AMUX_V22_TRANSFER_CHUNK_BYTES) * 1000;
};

/**
 * A changed-path list on the wire and at rest: each path's UTF-8 bytes
 * followed by one NUL (as `git -z` writes them), in the order the sidecar
 * produced them.
 */
export function encodeAmuxV22ChangedPaths(paths: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      throw new TypeError("invalid changed path");
    }
    if (seen.has(path)) throw new TypeError("duplicate changed path");
    seen.add(path);
    parts.push(Buffer.from(path, "utf8"), Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

/** The inverse of encodeAmuxV22ChangedPaths; throws on anything else. */
export function decodeAmuxV22ChangedPaths(bytes: Buffer, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("invalid changed path count");
  }
  if (bytes.length === 0) {
    if (count !== 0) throw new TypeError("changed path count mismatch");
    return [];
  }
  if (bytes[bytes.length - 1] !== 0) throw new TypeError("changed paths not NUL terminated");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  const seen = new Set<string>();
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new TypeError("empty changed path");
    const path = decoder.decode(bytes.subarray(start, index));
    if (seen.has(path)) throw new TypeError("duplicate changed path");
    seen.add(path);
    paths.push(path);
    start = index + 1;
  }
  if (paths.length !== count) throw new TypeError("changed path count mismatch");
  return paths;
}
