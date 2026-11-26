import assert from "node:assert/strict";
import test from "node:test";
import { diffTexts, joinText, parseUnifiedDiff, planHunkRevert, reviewDiffText, splitText } from "../src/host/review-diff";
import type { ReviewFile } from "../src/review-contract";

const lines = (count: number, tag = "line") => Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`);
const text = (...rows: string[]) => rows.join("\n") + "\n";

/** Puts every hunk of a diff back, last first so the line numbers of the earlier ones stay true. */
function revertAll(file: ReviewFile, after: string, status: ReviewFile["status"] = file.status) {
  let current: string | null = after;
  for (const hunk of [...file.hunks].reverse()) {
    const plan = planHunkRevert(current === null ? null : Buffer.from(current), { status, hunk });
    assert.ok(plan.ok, JSON.stringify(plan));
    current = plan.text;
  }
  return current;
}

test("two texts are compared into hunks with three lines of context, and every hunk puts back", () => {
  const before = text(...lines(40));
  const rows = lines(40);
  rows[3] = "changed 4";
  rows.splice(20, 2);
  rows.splice(30, 0, "inserted after 32");
  const after = text(...rows);
  const file = diffTexts("a.txt", before, after);
  assert.equal(file.status, "modified");
  assert.equal(file.hunks.length, 3);
  assert.deepEqual([file.added, file.removed], [2, 3]);
  const [first] = file.hunks;
  assert.equal(first!.header, "@@ -1,7 +1,7 @@");
  assert.deepEqual(first!.lines.map((line) => line.kind), ["context", "context", "context", "remove", "add", "context", "context", "context"]);
  assert.equal(revertAll(file, after), before);
  assert.equal(new Set(file.hunks.map((hunk) => hunk.id)).size, 3);
});

test("a change in the last line's ending shows as a change, and putting it back restores the ending", () => {
  const before = "one\ntwo";
  const after = "one\ntwo\n";
  const file = diffTexts("a.txt", before, after);
  assert.equal(file.hunks.length, 1);
  assert.deepEqual(file.hunks[0]!.lines.map((line) => [line.kind, line.text, line.noEol === true]),
    [["context", "one", false], ["remove", "two", true], ["add", "two", false]]);
  assert.equal(revertAll(file, after), before);
  const reverse = diffTexts("a.txt", after, before);
  assert.equal(revertAll(reverse, before), after);
});

test("added and deleted files are one hunk, and putting one back deletes or recreates the file", () => {
  const created = diffTexts("new.txt", null, text("a", "b"));
  assert.equal(created.status, "added");
  assert.equal(created.hunks[0]!.header, "@@ -0,0 +1,2 @@");
  assert.deepEqual(planHunkRevert(Buffer.from(text("a", "b")), { status: "added", hunk: created.hunks[0]! }), { ok: true, action: "delete", text: null });
  assert.deepEqual(planHunkRevert(Buffer.from(text("a", "b", "c")), { status: "added", hunk: created.hunks[0]! }), { ok: false, reason: "stale" });
  assert.deepEqual(planHunkRevert(null, { status: "added", hunk: created.hunks[0]! }), { ok: false, reason: "stale" });
  const deleted = diffTexts("gone.txt", text("x", "y"), null);
  assert.equal(deleted.status, "deleted");
  assert.deepEqual(planHunkRevert(null, { status: "deleted", hunk: deleted.hunks[0]! }), { ok: true, action: "create", text: text("x", "y") });
  // A file that appeared in its place since is never replaced.
  assert.deepEqual(planHunkRevert(Buffer.from("other\n"), { status: "deleted", hunk: deleted.hunks[0]! }), { ok: false, reason: "stale" });
});

test("a hunk is refused unless its lines are in the file exactly where the diff said", () => {
  const before = text(...lines(10));
  const rows = lines(10);
  rows[4] = "five, changed";
  const file = diffTexts("a.txt", before, text(...rows));
  const hunk = file.hunks[0]!;
  const apply = (current: string) => planHunkRevert(Buffer.from(current), { status: "modified", hunk });
  assert.ok(apply(text(...rows)).ok);
  // The person edited the changed line, a line above (moving it), or the file shrank.
  rows[4] = "five, edited";
  assert.deepEqual(apply(text(...rows)), { ok: false, reason: "stale" });
  rows[4] = "five, changed";
  assert.deepEqual(apply(text("new first line", ...rows)), { ok: false, reason: "stale" });
  assert.deepEqual(apply(text(...rows.slice(0, 5))), { ok: false, reason: "stale" });
  // A change elsewhere in the file (here: the final newline) does not stop a hunk that does not touch it.
  const unrelated = apply(text(...rows).replace(/\n$/, ""));
  assert.ok(unrelated.ok && unrelated.text!.endsWith("line 10"));
  assert.deepEqual(planHunkRevert(null, { status: "modified", hunk }), { ok: false, reason: "stale" });
  // Not text: no NUL bytes, no invalid UTF-8.
  assert.deepEqual(planHunkRevert(Buffer.from([0x61, 0, 0x62]), { status: "modified", hunk }), { ok: false, reason: "unsupported" });
  assert.deepEqual(planHunkRevert(Buffer.from([0xff, 0xfe, 0x41]), { status: "modified", hunk }), { ok: false, reason: "unsupported" });
});

test("a file with CRLF endings keeps them, and a byte-order mark stays", () => {
  const before = ["﻿alpha", "beta", "gamma", "delta", "epsilon"].join("\r\n") + "\r\n";
  const after = ["﻿alpha", "beta", "GAMMA", "delta", "epsilon"].join("\r\n") + "\r\n";
  const file = diffTexts("c.txt", before, after);
  const plan = planHunkRevert(Buffer.from(after), { status: "modified", hunk: file.hunks[0]! });
  assert.deepEqual(plan, { ok: true, action: "update", text: before });
  // The same hunk as git prints it for a CRLF file: every line ends with a CR.
  const raw = parseUnifiedDiff(["diff --git a/c.txt b/c.txt", "--- a/c.txt", "+++ b/c.txt", "@@ -1,5 +1,5 @@",
    " ﻿alpha\r", " beta\r", "-gamma\r", "+GAMMA\r", " delta\r", " epsilon\r", ""].join("\n"), ["c.txt"]);
  assert.deepEqual(planHunkRevert(Buffer.from(after), { status: "modified", hunk: raw[0]!.hunks[0]! }), { ok: true, action: "update", text: before });
});

test("git's unified diff is read into files and hunks, and what cannot be read is named", () => {
  const diff = [
    "diff --git a/src/a b.ts b/src/a b.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a b.ts",
    "+++ b/src/a b.ts",
    "@@ -1,3 +1,3 @@ function f() {",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10 +10,2 @@",
    "-ten",
    "\\ No newline at end of file",
    "+ten",
    "+eleven",
    "diff --git a/img.png b/img.png",
    "index 3333333..4444444 100644",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-x",
    "-y",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff, ["src/a b.ts", "img.png", "old.txt", "\"odd\".txt"]);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.omitted ?? null, file.hunks.length]),
    [["src/a b.ts", "modified", null, 2], ["img.png", "modified", "binary", 0], ["old.txt", "deleted", null, 1], ["\"odd\".txt", "modified", "unreadable", 0]]);
  const [first, second] = files[0]!.hunks;
  assert.deepEqual(first!.lines.map((line) => [line.kind, line.oldNo ?? null, line.newNo ?? null]),
    [["context", 1, 1], ["remove", 2, null], ["add", null, 2], ["context", 3, 3]]);
  assert.deepEqual(second!.lines.map((line) => [line.kind, line.text, line.noEol === true]), [["remove", "ten", true], ["add", "ten", false], ["add", "eleven", false]]);
  assert.deepEqual([files[0]!.added, files[0]!.removed], [3, 2]);
  assert.deepEqual([files[2]!.added, files[2]!.removed], [0, 2]);
});

test("a long diff for a reviewer stops at a file boundary and says what was left out", () => {
  const files = ["a.txt", "b.txt", "c.txt"].map((path) => diffTexts(path, text(...lines(30, path)), text(...lines(30, path)).replace("1\n", "one\n")));
  const whole = reviewDiffText({ scope: "uncommitted", files });
  assert.equal(whole.truncated, false);
  assert.match(whole.text, /^diff --git a\/a.txt b\/a.txt\n@@/);
  const short = reviewDiffText({ scope: "uncommitted", files }, whole.text.length / 2);
  assert.equal(short.truncated, true);
  assert.match(short.text, /\[\d+ more file\(s\) not shown/);
  assert.ok(short.text.includes("diff --git a/a.txt"));
  assert.ok(!short.text.includes("diff --git a/c.txt"));
});

test("splitting and joining a text is exact for every ending", () => {
  for (const sample of ["", "\n", "a", "a\n", "a\n\n", "\n\na", "a\r\nb\r\n"]) {
    const { lines: parts, eol } = splitText(sample);
    assert.equal(joinText(parts, eol), sample, JSON.stringify(sample));
  }
});

test("random edits always round trip through the hunks", () => {
  let seed = 7;
  const next = (limit: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % limit; };
  for (let round = 0; round < 60; round += 1) {
    const before = Array.from({ length: next(30) }, (_, i) => `row ${i} ${next(4)}`);
    const after = [...before];
    for (let edit = next(6); edit > 0; edit -= 1) {
      const at = next(after.length + 1);
      if (next(2) === 0) after.splice(at, next(3), ...Array.from({ length: next(3) }, () => `new ${next(1000)}`));
      else after.splice(at, 0, `dup ${next(3)}`);
    }
    const eol = next(2) === 0;
    const a = joinText(before, eol && before.length > 0);
    const b = joinText(after, eol && after.length > 0);
    if (a === b) continue;
    const file = diffTexts("r.txt", a, b);
    if (file.omitted) continue;
    assert.equal(revertAll(file, b, "modified"), a, `round ${round}`);
  }
});
