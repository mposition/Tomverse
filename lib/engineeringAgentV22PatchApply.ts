import { isCanonicalRepoPath } from "@/lib/agentAuthorityFiles";
import { gitObjectId } from "@/lib/engineeringAgentTreeVerify";

/**
 * A stored v22 patch with no file list (the sidecar keeps file bytes only for
 * at most five files and 48 KiB) is rebuilt here against the pinned base
 * blobs. Only the exact shape `git diff --binary --no-renames` writes for a
 * modified text file is read. Its `index` line names the old and new blob ids
 * (abbreviated for text): the pinned base blob must be the old one, and a
 * rebuilt file counts only when its blob id is the new one the diff named.
 * The publisher still applies the patch with git and matches the tree before
 * any push. Anything else -- a new,
 * deleted or renamed file, a mode change, a binary patch, a quoted path, a
 * hunk that does not sit exactly where it says -- is refused, never fuzzed.
 */
export type V22DiffLine = { op: " " | "-" | "+"; text: string; eol: boolean };
export type V22DiffHunk = { oldStart: number; oldCount: number;
  newStart: number; newCount: number; lines: V22DiffLine[] };
/** `oldOid` and `newOid` are the diff's blob ids, possibly abbreviated. */
export type V22DiffFile = { path: string; oldOid: string; newOid: string;
  hunks: V22DiffHunk[] };

const DIFF = /^diff --git a\/(\S+) b\/(\S+)$/;
const INDEX = /^index ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40}) 100644$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NO_EOL = "\\ No newline at end of file";
const ZERO = /^0+$/;
const MAX_LINE_NUMBER = 1_000_000;

export function parseV22GitDiff(text: string):
  { ok: true; files: V22DiffFile[] } | { ok: false } {
  const lines = text.split("\n");
  if (lines.pop() !== "" || lines.length === 0) return { ok: false };
  const files: V22DiffFile[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const head = DIFF.exec(lines[i++]);
    const path = head?.[1];
    if (!head || !path || head[2] !== path || !isCanonicalRepoPath(path) ||
        seen.has(path)) return { ok: false };
    seen.add(path);
    const index = INDEX.exec(lines[i++] ?? "");
    if (!index || ZERO.test(index[1]) || ZERO.test(index[2]) ||
        index[1] === index[2] ||
        lines[i++] !== `--- a/${path}` || lines[i++] !== `+++ b/${path}`)
      return { ok: false };
    const hunks: V22DiffHunk[] = [];
    while (i < lines.length && lines[i].startsWith("@@ ")) {
      const header = HUNK.exec(lines[i++]);
      if (!header) return { ok: false };
      const [oldStart, oldCount, newStart, newCount] = [header[1],
        header[2] ?? "1", header[3], header[4] ?? "1"].map(Number);
      if ([oldStart, oldCount, newStart, newCount].some((value) =>
        !Number.isSafeInteger(value) || value > MAX_LINE_NUMBER) ||
          oldCount + newCount === 0) return { ok: false };
      const hunk: V22DiffHunk = { oldStart, oldCount, newStart, newCount,
        lines: [] };
      let oldLeft = oldCount;
      let newLeft = newCount;
      while (oldLeft > 0 || newLeft > 0) {
        const line = lines[i++];
        const op = line?.[0];
        if (op !== " " && op !== "-" && op !== "+") return { ok: false };
        if (op !== "+" && oldLeft-- === 0) return { ok: false };
        if (op !== "-" && newLeft-- === 0) return { ok: false };
        const entry: V22DiffLine = { op, text: line.slice(1), eol: true };
        if (lines[i] === NO_EOL) { entry.eol = false; i++; }
        hunk.lines.push(entry);
      }
      hunks.push(hunk);
    }
    if (hunks.length === 0) return { ok: false };
    files.push({ path, oldOid: index[1], newOid: index[2], hunks });
  }
  return { ok: true, files };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The rebuilt bytes, or null when the diff does not apply to `base` exactly
 * or does not yield the blob the diff names. */
export function applyV22FileDiff(base: Uint8Array, file: V22DiffFile):
  Uint8Array | null {
  if (!gitObjectId("blob", base).startsWith(file.oldOid)) return null;
  let source: string;
  try { source = utf8.decode(base); } catch { return null; }
  if (source.includes("\0")) return null;
  // Each token keeps its own line ending, so a last line with none stays so.
  const tokens = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const oldAt = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newAt = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (oldAt < cursor || oldAt + hunk.oldCount > tokens.length) return null;
    for (; cursor < oldAt; cursor++) out.push(tokens[cursor]);
    if (out.length !== newAt) return null;
    for (const line of hunk.lines) {
      const token = line.eol ? `${line.text}\n` : line.text;
      if (line.op !== "+") {
        if (tokens[cursor] !== token) return null;
        cursor++;
      }
      if (line.op !== "-") out.push(token);
    }
  }
  for (; cursor < tokens.length; cursor++) out.push(tokens[cursor]);
  if (out.slice(0, -1).some((token) => !token.endsWith("\n"))) return null;
  const bytes = Buffer.from(out.join(""), "utf8");
  if (!gitObjectId("blob", bytes).startsWith(file.newOid)) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}
