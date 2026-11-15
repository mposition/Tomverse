import { isCanonicalRepoPath } from "@/lib/agentAuthorityFiles";
import { decodeV22Base85, inflateV22BinaryHunk } from "@/lib/amux/v22PatchBinary";
import { AMUX_V22_FILE_MAX_BYTES } from "@/lib/amux/v22PatchLimit";
import { gitObjectId } from "@/lib/engineeringAgentTreeVerify";

/**
 * A stored v22 patch is rebuilt here against the pinned base blobs, in
 * memory, without running git (docs/policy/engineering-agent.md §11: the app
 * never executes a patch; the publisher applies it with `git apply --cached`
 * and refuses to push unless its tree equals the one built here).
 *
 * Every shape `git diff --binary` writes for a regular file, an executable or
 * a symlink is read (owner decision 2026-11-15): a change, a new or deleted
 * file (empty ones too), a mode change, a rename or copy, and a binary file
 * as a literal or a delta. A hunk must sit exactly where it says (no offset,
 * no fuzz), and a file's rebuilt bytes must hash to the blob id its `index`
 * line names. What this cannot rebuild -- a submodule, a binary file written
 * without its data, any text that is not git's own format -- is refused,
 * never guessed: the patch then stays a private draft for a person.
 */
export type V22DiffLine = { op: " " | "-" | "+"; text: string; eol: boolean };
export type V22DiffHunk = { oldStart: number; oldCount: number;
  newStart: number; newCount: number; lines: V22DiffLine[] };
/** One side of `GIT binary patch`: deflated bytes, as git wrote them. */
export type V22BinaryHunk = { kind: "literal" | "delta"; size: number;
  data: Uint8Array };
export type V22FileMode = "100644" | "100755" | "120000";
/**
 * One file of a patch. A null path is `/dev/null`: no old side for a new file,
 * no new side for a deleted one. A null mode on an existing side means the
 * mode the base has (git names none for a pure rename); a null new mode keeps
 * the old one. `oldOid` and `newOid` are the `index` line's ids, possibly
 * abbreviated, or null where the file has no `index` line.
 */
export type V22DiffFile = {
  oldPath: string | null; newPath: string | null;
  oldMode: V22FileMode | null; newMode: V22FileMode | null;
  oldOid: string | null; newOid: string | null;
  /** A copy reads its old side and leaves it in place. */
  copy: boolean;
  body: { kind: "none" } | { kind: "text"; hunks: V22DiffHunk[] } |
    { kind: "binary"; forward: V22BinaryHunk };
};
export type V22DiffRefusal = "patch_unreadable" | "path_invalid";

const MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);
const MODE = "(\\d{6})";
const OID = "([0-9a-f]{7,40})";
/** The value of an `index` line. */
const INDEX = new RegExp(`^${OID}\\.\\.${OID}(?: ${MODE})?$`);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const BINARY = /^(literal|delta) (\d+)$/;
const NO_EOL = "\\ No newline at end of file";
const ZERO = /^0+$/;
const MAX_LINE_NUMBER = 100_000_000;

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9,
  n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A path as git writes it: bare, or C-quoted (`"\303\251.ts"`). */
function unquote(text: string): string | null {
  if (!text.startsWith('"')) return text;
  const chars = Array.from(text);
  if (chars.length < 2 || chars[chars.length - 1] !== '"') return null;
  const bytes: number[] = [];
  for (let i = 1; i < chars.length - 1; i += 1) {
    const char = chars[i];
    if (char === '"') return null;
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const next = chars[i + 1] ?? "";
    if (next in SIMPLE_ESCAPES) { bytes.push(SIMPLE_ESCAPES[next]); i += 1; continue; }
    const octal = chars.slice(i + 1, i + 4).join("");
    if (!/^[0-3][0-7]{2}$/.test(octal)) return null;
    bytes.push(Number.parseInt(octal, 8));
    i += 3;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch { return null; }
}

/** The end of the C-quoted string starting at `start`, or -1. */
const quoteEnd = (text: string, start: number) => {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === '"') return i;
  }
  return -1;
};

const stripPrefix = (name: string | null, prefix: string) =>
  name !== null && name.startsWith(prefix) ? name.slice(prefix.length) : null;

/** `a/X b/X` names, when git can tell them apart: either is quoted, or both
 * are the same (a pure rename names its paths on its own lines instead). */
function headerNames(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = quoteEnd(rest, 0);
    if (end < 0 || rest[end + 1] !== " ") return null;
    const a = stripPrefix(unquote(rest.slice(0, end + 1)), "a/");
    const b = stripPrefix(unquote(rest.slice(end + 2)), "b/");
    return a !== null && b !== null ? [a, b] : null;
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "b/');
    if (start < 0) return null;
    const a = stripPrefix(rest.slice(0, start), "a/");
    const b = stripPrefix(unquote(rest.slice(start + 1)), "b/");
    return a !== null && b !== null ? [a, b] : null;
  }
  if (rest.length % 2 === 0) return null;
  const half = (rest.length - 1) / 2;
  const a = stripPrefix(rest.slice(0, half), "a/");
  const b = stripPrefix(rest.slice(half + 1), "b/");
  return rest[half] === " " && a !== null && a === b ? [a, b] : null;
}

/** A `---`/`+++` line's path: git adds a tab after a name with a space. */
function markerPath(line: string, marker: string, prefix: string):
  string | null | undefined {
  if (!line.startsWith(marker)) return undefined;
  let name = line.slice(marker.length);
  if (name === "/dev/null") return null;
  if (name.endsWith("\t")) name = name.slice(0, -1);
  return stripPrefix(unquote(name), prefix) ?? undefined;
}

/** Git's delta: the base and result sizes, then copy and insert commands. */
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array | null {
  let at = 0;
  const size = () => {
    let value = 0;
    for (let shift = 0; shift < 49; shift += 7) {
      if (at >= delta.length) return -1;
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return -1;
  };
  const source = size();
  const target = size();
  if (source !== base.length || target < 0 ||
      target > AMUX_V22_FILE_MAX_BYTES) return null;
  const out = Buffer.alloc(target);
  let written = 0;
  while (at < delta.length) {
    const command = delta[at++];
    if (command & 0x80) {
      let offset = 0;
      let length = 0;
      for (let k = 0; k < 4; k += 1) {
        if (!(command & (1 << k))) continue;
        if (at >= delta.length) return null;
        offset += delta[at++] * 2 ** (8 * k);
      }
      for (let k = 0; k < 3; k += 1) {
        if (!(command & (0x10 << k))) continue;
        if (at >= delta.length) return null;
        length += delta[at++] * 2 ** (8 * k);
      }
      if (length === 0) length = 0x10000;
      if (offset + length > base.length || written + length > target)
        return null;
      out.set(base.subarray(offset, offset + length), written);
      written += length;
    } else if (command !== 0) {
      if (at + command > delta.length || written + command > target)
        return null;
      out.set(delta.subarray(at, at + command), written);
      written += command;
      at += command;
    } else return null;
  }
  return written === target ? out : null;
}

type Parsed = { ok: true; files: V22DiffFile[] } |
  { ok: false; reason: V22DiffRefusal };

export function parseV22GitDiff(text: string): Parsed {
  const unreadable = { ok: false, reason: "patch_unreadable" } as const;
  const lines = text.split("\n");
  if (lines.pop() !== "" || lines.length === 0) return unreadable;
  const files: V22DiffFile[] = [];
  // Each path is read as an old side and written as a new side at most once;
  // a deleted path may be created again (git writes a type change so).
  const consumed = new Set<string>();
  const written = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const head = lines[i++];
    if (!head.startsWith("diff --git ")) return unreadable;
    const names = headerNames(head.slice("diff --git ".length));
    const headers = new Map<string, string>();
    const once = (key: string, value: string) => {
      if (headers.has(key)) return false;
      headers.set(key, value);
      return true;
    };
    while (i < lines.length && !lines[i].startsWith("diff --git ") &&
        !lines[i].startsWith("--- ") && lines[i] !== "GIT binary patch" &&
        !lines[i].startsWith("Binary files ")) {
      const line = lines[i++];
      const match = /^(old mode|new mode|deleted file mode|new file mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index|index) (.+)$/.exec(line);
      if (!match || !once(match[1], match[2])) return unreadable;
    }
    const mode = (key: string) => {
      const value = headers.get(key);
      return value === undefined ? null : MODES.has(value) ?
        value as V22FileMode : undefined;
    };
    const created = headers.has("new file mode");
    const deleted = headers.has("deleted file mode");
    const renamed = headers.has("rename from") || headers.has("rename to");
    const copied = headers.has("copy from") || headers.has("copy to");
    const index = headers.has("index") ? INDEX.exec(headers.get("index")!) : null;
    if ((created && deleted) || (renamed && copied) || (headers.has("index") && !index) ||
        ((renamed || copied) && (created || deleted)))
      return unreadable;
    let oldPath: string | null;
    let newPath: string | null;
    if (renamed || copied) {
      oldPath = unquote(headers.get(renamed ? "rename from" : "copy from") ?? "");
      newPath = unquote(headers.get(renamed ? "rename to" : "copy to") ?? "");
      if (!oldPath || !newPath || oldPath === newPath ||
          (names && (names[0] !== oldPath || names[1] !== newPath)))
        return unreadable;
    } else {
      if (!names) return unreadable;
      oldPath = created ? null : names[0];
      newPath = deleted ? null : names[1];
    }
    for (const path of [oldPath, newPath])
      if (path !== null && !isCanonicalRepoPath(path))
        return { ok: false, reason: "path_invalid" };
    let oldMode = deleted ? mode("deleted file mode") : mode("old mode");
    let newMode = created ? mode("new file mode") : mode("new mode");
    if (oldMode === undefined || newMode === undefined ||
        (created && headers.has("old mode")) ||
        (deleted && headers.has("new mode")) ||
        (headers.has("old mode") !== headers.has("new mode")))
      return unreadable;
    if (index?.[3] !== undefined) {
      // The mode on the index line is both sides' when neither changed.
      if (!MODES.has(index[3]) || created || deleted || headers.has("old mode"))
        return unreadable;
      oldMode = newMode = index[3] as V22FileMode;
    }
    const oldOid = index?.[1] ?? null;
    const newOid = index?.[2] ?? null;
    // git abbreviates each id on its own, so their lengths may differ.
    if (index && (ZERO.test(oldOid!) !== created || ZERO.test(newOid!) !== deleted))
      return unreadable;
    if (!index && (created || deleted)) return unreadable;
    let body: V22DiffFile["body"] = { kind: "none" };
    if (lines[i]?.startsWith("--- ")) {
      const from = markerPath(lines[i++], "--- ", "a/");
      const to = markerPath(lines[i++] ?? "", "+++ ", "b/");
      if (from === undefined || to === undefined || from !== oldPath ||
          to !== newPath) return unreadable;
      const hunks: V22DiffHunk[] = [];
      while (i < lines.length && lines[i].startsWith("@@ ")) {
        const header = HUNK.exec(lines[i++]);
        if (!header) return unreadable;
        const [oldStart, oldCount, newStart, newCount] = [header[1],
          header[2] ?? "1", header[3], header[4] ?? "1"].map(Number);
        if ([oldStart, oldCount, newStart, newCount].some((value) =>
          !Number.isSafeInteger(value) || value > MAX_LINE_NUMBER) ||
            oldCount + newCount === 0) return unreadable;
        const hunk: V22DiffHunk = { oldStart, oldCount, newStart, newCount,
          lines: [] };
        let oldLeft = oldCount;
        let newLeft = newCount;
        while (oldLeft > 0 || newLeft > 0) {
          const line = lines[i++];
          const op = line?.[0];
          if (op !== " " && op !== "-" && op !== "+") return unreadable;
          if (op !== "+" && oldLeft-- === 0) return unreadable;
          if (op !== "-" && newLeft-- === 0) return unreadable;
          const entry: V22DiffLine = { op, text: line.slice(1), eol: true };
          if (lines[i] === NO_EOL) { entry.eol = false; i++; }
          hunk.lines.push(entry);
        }
        hunks.push(hunk);
      }
      if (hunks.length === 0 || !index) return unreadable;
      body = { kind: "text", hunks };
    } else if (lines[i] === "GIT binary patch") {
      i++;
      const read = (): V22BinaryHunk | null => {
        const header = BINARY.exec(lines[i++] ?? "");
        if (!header) return null;
        const data: string[] = [];
        while (i < lines.length && lines[i] !== "") data.push(lines[i++]);
        if (lines[i++] !== "") return null;
        const bytes = decodeV22Base85(data);
        const size = Number(header[2]);
        return bytes && Number.isSafeInteger(size) ? { kind:
          header[1] as V22BinaryHunk["kind"], size, data: bytes } : null;
      };
      const forward = read();
      // The reverse side, which `--binary` adds, is read only to be skipped.
      if (!forward || (BINARY.test(lines[i] ?? "") && !read()) || !index)
        return unreadable;
      body = { kind: "binary", forward };
    } else if (lines[i]?.startsWith("Binary files ")) {
      // A binary change written without its data cannot be rebuilt.
      return unreadable;
    }
    if (body.kind === "none" && !created && !deleted && !renamed && !copied &&
        !headers.has("old mode")) return unreadable;
    // A rename or copy that changes content carries an index line.
    if (body.kind === "none" && index && !created && !deleted) return unreadable;
    const reads = renamed || !copied ? oldPath : null;
    if ((reads !== null && consumed.has(reads)) ||
        (newPath !== null && written.has(newPath))) return unreadable;
    if (reads !== null) consumed.add(reads);
    if (newPath !== null) written.add(newPath);
    files.push({ oldPath, newPath, oldMode, newMode, oldOid, newOid,
      copy: copied, body });
  }
  // git reads a copy's source as earlier files of the same patch left it;
  // this reads the base. A copy of a path the patch also changes is refused
  // rather than rebuilt differently from the publisher's tree.
  if (files.some((file) => file.copy && consumed.has(file.oldPath!)))
    return unreadable;
  return { ok: true, files };
}

/** Every path a patch names (both sides of a rename or copy) and every path
 * an older sidecar stored bytes for, for the v52 check that the runner's
 * inventory covers the patch (decideAmuxV52SettlementPaths). Null when the
 * text is not a diff this reads and no bytes were stored: there is then no
 * candidate to cover. Until 2026-11-15 only the stored bytes (at most five
 * files) were checked. */
export const v22PatchNamedPaths = (text: string,
  files: readonly { path: string }[] | null): { path: string }[] | null => {
  const names = new Set(files?.map((file) => file.path) ?? []);
  const parsed = parseV22GitDiff(text);
  if (parsed.ok) for (const file of parsed.files)
    for (const path of [file.oldPath, file.newPath])
      if (path !== null) names.add(path);
  return names.size ? [...names].map((path) => ({ path })) : null;
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function applyHunks(base: Uint8Array, hunks: readonly V22DiffHunk[]):
  Uint8Array | null {
  let source: string;
  try { source = utf8.decode(base); } catch { return null; }
  if (source.includes("\0")) return null;
  // Each token keeps its own line ending, so a last line with none stays so.
  const tokens = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldAt = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newAt = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (oldAt < cursor || oldAt + hunk.oldCount > tokens.length) return null;
    // git applies a hunk with no trailing context only at the end of the file
    // and one at line 0 only at its start (apply.c: match_end,
    // match_beginning); placed anywhere else, git would not apply it as this
    // does, so it is refused. `git diff` writes neither.
    if (hunk.lines[hunk.lines.length - 1]?.op !== " " &&
        oldAt + hunk.oldCount !== tokens.length) return null;
    if (hunk.oldStart === 0 && out.length !== 0) return null;
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
  return Buffer.from(out.join(""), "utf8");
}

/**
 * The new bytes of one file, or null when the diff does not apply to `base`
 * exactly or does not yield the blob it names. `base` is the old side's
 * bytes, or null for a new file. A deleted file's result is empty.
 */
export function applyV22FileDiff(base: Uint8Array | null,
  file: V22DiffFile): Uint8Array | null {
  if ((file.oldPath === null) !== (base === null)) return null;
  if (base && file.oldOid !== null &&
      !gitObjectId("blob", base).startsWith(file.oldOid)) return null;
  const before = base ?? new Uint8Array();
  let next: Uint8Array | null;
  if (file.body.kind === "text") next = applyHunks(before, file.body.hunks);
  else if (file.body.kind === "binary") {
    const { forward } = file.body;
    const data = inflateV22BinaryHunk(forward.data, forward.size);
    next = data === null ? null : forward.kind === "literal" ? data :
      applyDelta(before, data);
  } else next = file.newPath === null ? new Uint8Array() : before;
  if (next === null) return null;
  // A file the diff names no new id for (a mode change, a pure rename) keeps
  // its bytes; anything else must have named one.
  const named = file.newPath === null ? next.length === 0 :
    file.newOid === null ? next === before :
      gitObjectId("blob", next).startsWith(file.newOid);
  if (!named) {
    if (next !== before) next.fill(0);
    return null;
  }
  return next;
}
