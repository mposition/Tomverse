import { inflateSync } from "node:zlib";

import { AMUX_V22_FILE_MAX_BYTES } from "./v22PatchLimit.ts";

/**
 * The bytes a `git diff --binary` patch carries in its `GIT binary patch`
 * sections. They are base85 text of deflated data, so a secret inside a
 * binary file is invisible to a scan of the patch text: every check that must
 * see what a patch publishes before it is stored (the sidecar's local
 * scanner, the app's evidence encoder) scans these bytes too
 * (docs/policy/engineering-agent.md §11). Dependency-free beyond node:zlib,
 * so the box sidecar bundles it as is.
 */

const B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
  "!#$%&()*+-;<=>?@^_`{|}~";
const B85_VALUE = new Map(Array.from(B85, (char, index) => [char, index]));
const HUNK = /^(literal|delta) (\d+)$/;

/** Git's base85 lines: a length letter, then five characters per four bytes. */
export function decodeV22Base85(lines: readonly string[]): Buffer | null {
  const counts = lines.map((line) => {
    const code = line.charCodeAt(0);
    return code >= 65 && code <= 90 ? code - 64 :
      code >= 97 && code <= 122 ? code - 70 : 0;
  });
  if (counts.some((count, index) => count === 0 ||
      lines[index].length !== 1 + Math.ceil(count / 4) * 5)) return null;
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > AMUX_V22_FILE_MAX_BYTES) return null;
  const out = Buffer.alloc(total);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let left = counts[index];
    for (let at = 1; at < line.length; at += 5) {
      let value = 0;
      for (let k = 0; k < 5; k += 1) {
        const digit = B85_VALUE.get(line[at + k]);
        if (digit === undefined) return null;
        value = value * 85 + digit;
      }
      if (value > 0xffffffff) return null;
      for (let k = 3; k >= 0 && left > 0; k -= 1, left -= 1)
        out[offset++] = (value >>> (8 * k)) & 0xff;
    }
  }
  return out;
}

/** One hunk's deflated data inflated to exactly the size it states. */
export function inflateV22BinaryHunk(data: Uint8Array, size: number):
  Buffer | null {
  if (!Number.isSafeInteger(size) || size < 0 || size > AMUX_V22_FILE_MAX_BYTES)
    return null;
  try {
    const out = inflateSync(data, { maxOutputLength: Math.max(size, 1) });
    return out.length === size ? out : null;
  } catch { return null; }
}

/** Every byte a git delta inserts, joined in order (a token split across two
 * insert commands is whole again); copies come from the base, which is
 * already published. Null when the delta is not git's format. */
function deltaInserts(delta: Uint8Array): Buffer | null {
  let at = 0;
  const size = () => {
    for (let shift = 0; shift < 49; shift += 7) {
      if (at >= delta.length) return false;
      if ((delta[at++] & 0x80) === 0) return true;
    }
    return false;
  };
  if (!size() || !size()) return null;
  const parts: Uint8Array[] = [];
  while (at < delta.length) {
    const command = delta[at++];
    if (command & 0x80) {
      for (let bit = 0; bit < 7; bit += 1) if (command & (1 << bit)) at += 1;
      if (at > delta.length) return null;
    } else if (command !== 0) {
      if (at + command > delta.length) return null;
      parts.push(delta.subarray(at, at + command));
      at += command;
    } else return null;
  }
  return Buffer.concat(parts);
}

/**
 * What every forward hunk adds -- a new or replaced file's whole bytes, or
 * the bytes a delta inserts -- or null when a binary section cannot be read
 * (then nothing may be stored on the strength of a scan). The reverse hunk,
 * the old bytes the base already publishes, is skipped.
 */
export function v22PatchBinaryPayloads(text: string): Buffer[] | null {
  const lines = text.split("\n");
  const payloads: Buffer[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== "GIT binary patch") continue;
    const header = HUNK.exec(lines[i + 1] ?? "");
    if (!header) return null;
    const data: string[] = [];
    let at = i + 2;
    while (at < lines.length && lines[at] !== "") data.push(lines[at++]);
    const bytes = decodeV22Base85(data);
    const inflated = bytes && inflateV22BinaryHunk(bytes, Number(header[2]));
    const payload = inflated && (header[1] === "literal" ? inflated :
      deltaInserts(inflated));
    if (!payload) return null;
    payloads.push(payload);
    i = at;
  }
  return payloads;
}
