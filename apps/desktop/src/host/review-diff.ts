import { createHash } from "node:crypto";
import { MAX_REVIEW_DIFF_CHARACTERS, type ReviewDiff, type ReviewFile, type ReviewHunk, type ReviewLine } from "../review-contract";

/**
 * Pure diff helpers for the review panel: reading git's unified diff, diffing two texts (the last
 * turn is two texts the session recorded), and taking one hunk back out of a file's current text.
 * Nothing here touches the disk, so every rule is tested on strings.
 */

export const MAX_REVIEW_FILES = 400;
export const MAX_REVIEW_FILE_LINES = 6_000;
const CONTEXT = 3;
/** The size above which two texts are not compared line by line (the file is shown as replaced). */
const MAX_COMPARISON_CELLS = 4_000_000;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fileIdFor = (path: string) => digest(["file", path]).slice(0, 16);
export function hunkIdFor(path: string, hunk: Pick<ReviewHunk, "header" | "lines">) {
  return digest(["hunk", path, hunk.header, hunk.lines.map((line) => `${line.kind[0]}${line.noEol ? "\\" : ""}${line.text}`)]).slice(0, 16);
}

/** A text as lines without terminators, and whether its last line ends with a newline. */
export function splitText(text: string): { lines: string[]; eol: boolean } {
  if (text === "") return { lines: [], eol: false };
  const parts = text.split("\n");
  const eol = parts.at(-1) === "";
  return { lines: eol ? parts.slice(0, -1) : parts, eol };
}
export const joinText = (lines: readonly string[], eol: boolean) => (lines.length ? lines.join("\n") + (eol ? "\n" : "") : "");

function finishFile(path: string, status: ReviewFile["status"], hunks: ReviewHunk[], omitted?: ReviewFile["omitted"]): ReviewFile {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "remove") removed += 1;
    }
  }
  return { id: fileIdFor(path), path, status, added, removed, hunks, ...(omitted ? { omitted } : {}) };
}

export const omittedFile = (path: string, omitted: NonNullable<ReviewFile["omitted"]>, status: ReviewFile["status"] = "modified") =>
  finishFile(path, status, [], omitted);

function withHunkIds(path: string, hunks: Omit<ReviewHunk, "id">[]): ReviewHunk[] {
  return hunks.map((hunk) => ({ ...hunk, id: hunkIdFor(path, hunk) }));
}

// ---- git's unified diff ---------------------------------------------------------------------

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads the output of `git diff --no-renames --src-prefix=a/ --dst-prefix=b/`. `known` is the exact list of
 * changed paths (from `--name-only -z`): a file header is matched against it, so a path with spaces needs no
 * guessing, and a path git had to quote is reported as unreadable instead of being misread.
 */
export function parseUnifiedDiff(text: string, known: readonly string[]): ReviewFile[] {
  const lines = text.split("\n");
  const files: ReviewFile[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith("diff --git ")) { index += 1; continue; }
    index += 1;
    const rest = line.slice("diff --git ".length);
    const length = (rest.length - 5) / 2;
    const path = Number.isInteger(length) && length > 0 ? rest.slice(2, 2 + length) : "";
    const readable = path !== "" && rest === `a/${path} b/${path}` && known.includes(path);
    let status: ReviewFile["status"] = "modified";
    let binary = false;
    while (index < lines.length && !lines[index]!.startsWith("@@") && !lines[index]!.startsWith("diff --git ")) {
      const header = lines[index]!;
      if (header.startsWith("new file mode")) status = "added";
      else if (header.startsWith("deleted file mode")) status = "deleted";
      else if (header.startsWith("Binary files ") || header.startsWith("GIT binary patch")) binary = true;
      index += 1;
    }
    const hunks: Omit<ReviewHunk, "id">[] = [];
    while (index < lines.length && lines[index]!.startsWith("@@")) {
      const match = hunkHeader.exec(lines[index]!);
      index += 1;
      if (!match) break;
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      const body: ReviewLine[] = [];
      let oldLeft = oldCount;
      let newLeft = newCount;
      let oldNo = oldStart;
      let newNo = newStart;
      while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const row = lines[index]!;
        const mark = row[0];
        if (mark === "\\") break;
        if (mark === "+") { body.push({ kind: "add", text: row.slice(1), newNo }); newNo += 1; newLeft -= 1; }
        else if (mark === "-") { body.push({ kind: "remove", text: row.slice(1), oldNo }); oldNo += 1; oldLeft -= 1; }
        else if (mark === " " || row === "") { body.push({ kind: "context", text: row.slice(1), oldNo, newNo }); oldNo += 1; newNo += 1; oldLeft -= 1; newLeft -= 1; }
        else break;
        index += 1;
        if (lines[index]?.startsWith("\\")) { body.at(-1)!.noEol = true; index += 1; }
      }
      hunks.push({ header: match[0], oldStart, oldCount, newStart, newCount, lines: body });
    }
    if (!path || !readable) continue;
    seen.add(path);
    files.push(binary ? omittedFile(path, "binary", status) : finishFile(path, status, withHunkIds(path, hunks)));
  }
  for (const path of known) {
    if (!seen.has(path)) files.push(omittedFile(path, "unreadable"));
  }
  return files;
}

// ---- two texts --------------------------------------------------------------------------------

type Step = { kind: "equal" | "remove" | "add"; a?: number; b?: number };

function compare(a: readonly string[], b: readonly string[]): Step[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const steps: Step[] = [];
  for (let i = 0; i < start; i += 1) steps.push({ kind: "equal", a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= MAX_COMPARISON_CELLS) {
    // Longest common subsequence of the middle, read back from the end of both sides.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { steps.push({ kind: "equal", a: start + i, b: start + j }); i += 1; j += 1; }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { steps.push({ kind: "remove", a: start + i }); i += 1; }
      else { steps.push({ kind: "add", b: start + j }); j += 1; }
    }
    for (; i < n; i += 1) steps.push({ kind: "remove", a: start + i });
    for (; j < m; j += 1) steps.push({ kind: "add", b: start + j });
  } else {
    for (let i = 0; i < n; i += 1) steps.push({ kind: "remove", a: start + i });
    for (let j = 0; j < m; j += 1) steps.push({ kind: "add", b: start + j });
  }
  for (let k = 0; k < a.length - endA; k += 1) steps.push({ kind: "equal", a: endA + k, b: endB + k });
  return steps;
}

/** The change from one text to another as hunks with three lines of context, the way git shows it. */
export function diffTexts(path: string, before: string | null, after: string | null): ReviewFile {
  const left = splitText(before ?? "");
  const right = splitText(after ?? "");
  // The last line counts as another line when its ending differs, so a lost or added final newline shows.
  const key = (side: { lines: string[]; eol: boolean }, i: number) => (i === side.lines.length - 1 && !side.eol ? `${side.lines[i]}\u0000` : side.lines[i]!);
  const a = left.lines.map((_, i) => key(left, i));
  const b = right.lines.map((_, i) => key(right, i));
  const steps = compare(a, b);
  const status: ReviewFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
  const hunks: Omit<ReviewHunk, "id">[] = [];
  const changed = steps.flatMap((step, i) => (step.kind === "equal" ? [] : [i]));
  let at = 0;
  while (at < changed.length) {
    let first = changed[at]!;
    let last = first;
    let next = at + 1;
    while (next < changed.length && changed[next]! - last <= CONTEXT * 2 + 1) { last = changed[next]!; next += 1; }
    at = next;
    first = Math.max(0, first - CONTEXT);
    last = Math.min(steps.length - 1, last + CONTEXT);
    const body: ReviewLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    for (let i = first; i <= last; i += 1) {
      const step = steps[i]!;
      const oldNo = step.a === undefined ? undefined : step.a + 1;
      const newNo = step.b === undefined ? undefined : step.b + 1;
      if (step.kind !== "add") { oldStart ||= oldNo!; oldCount += 1; }
      if (step.kind !== "remove") { newStart ||= newNo!; newCount += 1; }
      const text = step.kind === "add" ? right.lines[step.b!]! : left.lines[step.a!]!;
      const noEol = step.kind === "add" ? (!right.eol && step.b === right.lines.length - 1)
        : (!left.eol && step.a === left.lines.length - 1);
      body.push({ kind: step.kind === "equal" ? "context" : step.kind, text, ...(oldNo === undefined ? {} : { oldNo }), ...(newNo === undefined ? {} : { newNo }),
        ...(noEol ? { noEol: true as const } : {}) });
    }
    // git shows an empty side as the line before the change, with a count of zero.
    const oldAt = oldCount === 0 ? (body.find((line) => line.newNo !== undefined)?.newNo ?? 1) - 1 : oldStart;
    const newAt = newCount === 0 ? (body.find((line) => line.oldNo !== undefined)?.oldNo ?? 1) - 1 : newStart;
    hunks.push({ header: `@@ -${oldAt}${oldCount === 1 ? "" : `,${oldCount}`} +${newAt}${newCount === 1 ? "" : `,${newCount}`} @@`,
      oldStart: oldAt, oldCount, newStart: newAt, newCount, lines: body });
  }
  const tooLong = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) > MAX_REVIEW_FILE_LINES;
  return tooLong ? omittedFile(path, "large", status) : finishFile(path, status, withHunkIds(path, hunks));
}

// ---- the diff as text for a reviewer ------------------------------------------------------------

const prefixOf: Record<ReviewLine["kind"], string> = { context: " ", add: "+", remove: "-" };

/** The whole diff in one text, the form a reviewer reads. Files that do not fit are named, not cut in half. */
export function reviewDiffText(diff: ReviewDiff, limit = MAX_REVIEW_DIFF_CHARACTERS): { text: string; truncated: boolean } {
  const blocks: string[] = [];
  let size = 0;
  let left = 0;
  for (const [position, file] of diff.files.entries()) {
    const head = [`diff --git a/${file.path} b/${file.path}`,
      ...(file.status === "added" ? ["new file"] : file.status === "deleted" ? ["deleted file"] : [])];
    const body = file.omitted ? [`(${file.omitted === "binary" ? "binary file" : "content"} not shown: ${file.omitted})`]
      : file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.flatMap((line) => [prefixOf[line.kind] + line.text,
        ...(line.noEol ? ["\\ No newline at end of file"] : [])])]);
    const block = [...head, ...body].join("\n");
    if (size + block.length > limit && blocks.length) { left = diff.files.length - position; break; }
    blocks.push(block.length > limit ? `${block.slice(0, limit)}\n[file cut: too long]` : block);
    size += block.length;
  }
  const truncated = left > 0 || diff.truncated === true;
  return { text: blocks.join("\n") + (left > 0 ? `\n[${left} more file(s) not shown: the diff is too long]` : ""), truncated };
}

// ---- taking one hunk back out -------------------------------------------------------------------

export type HunkRevertInput = {
  status: ReviewFile["status"];
  hunk: Pick<ReviewHunk, "newStart" | "newCount" | "lines">;
};
export type HunkRevertPlan =
  | { ok: true; action: "update" | "delete" | "create"; text: string | null }
  | { ok: false; reason: "stale" | "unsupported" };

const isText = (bytes: Buffer) => !bytes.subarray(0, 8192).includes(0) && Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);

/**
 * The result of putting one hunk back, or why it cannot be done. The hunk's lines as they are now must be in the file
 * exactly where the diff said (no search, no fuzz): anything else means the file changed since the diff was made, and
 * nothing is written over it. `current` is the file's bytes, or null when there is no file.
 */
export function planHunkRevert(current: Buffer | null, { status, hunk }: HunkRevertInput): HunkRevertPlan {
  const newSide = hunk.lines.filter((line) => line.kind !== "remove");
  const oldSide = hunk.lines.filter((line) => line.kind !== "add");
  if (status === "deleted") {
    // The file is gone; putting its content back must not replace one that has appeared since.
    if (current !== null) return { ok: false, reason: "stale" };
    const lastOld = oldSide.at(-1);
    return { ok: true, action: "create", text: joinText(oldSide.map((line) => line.text), !lastOld?.noEol) };
  }
  if (current === null) return { ok: false, reason: "stale" };
  if (!isText(current)) return { ok: false, reason: "unsupported" };
  const raw = current.toString("utf8");
  if (status === "added") {
    const { lines, eol } = splitText(raw);
    const lastNew = newSide.at(-1);
    const same = lines.length === newSide.length && lines.every((line, i) => line === newSide[i]!.text) && (lines.length === 0 || eol === !lastNew?.noEol);
    return same ? { ok: true, action: "delete", text: null } : { ok: false, reason: "stale" };
  }
  // A file with consistent CRLF endings is compared without the CR, as the patch tool does.
  const crlf = raw.includes("\r\n") && !/(^|[^\r])\n/.test(raw);
  const strip = (text: string) => (crlf && text.endsWith("\r") ? text.slice(0, -1) : text);
  const { lines, eol } = splitText(crlf ? raw.replaceAll("\r\n", "\n") : raw);
  const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
  if (start < 0 || start + newSide.length > lines.length) return { ok: false, reason: "stale" };
  for (const [i, line] of newSide.entries()) {
    if (lines[start + i] !== strip(line.text)) return { ok: false, reason: "stale" };
  }
  const reachesEnd = start + newSide.length === lines.length;
  const lastNew = newSide.at(-1);
  // A hunk that does not reach the end of the file cannot say the file has no final newline.
  if (reachesEnd ? newSide.length > 0 && eol === (lastNew?.noEol === true) : newSide.some((line) => line.noEol)) return { ok: false, reason: "stale" };
  const next = [...lines.slice(0, start), ...oldSide.map((line) => strip(line.text)), ...lines.slice(start + newSide.length)];
  const nextEol = reachesEnd ? oldSide.length === 0 ? false : oldSide.at(-1)!.noEol !== true : eol;
  const text = joinText(next, nextEol);
  const result = crlf ? text.replaceAll("\n", "\r\n") : text;
  return result === raw ? { ok: false, reason: "stale" } : { ok: true, action: "update", text: result };
}
