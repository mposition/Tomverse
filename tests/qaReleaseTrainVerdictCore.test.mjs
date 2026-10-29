import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseTrainWithContentVerdicts } from "../lib/qaReleaseTrainCargoCore.ts";
import {
  QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS,
  qaReleaseTrainContentGap,
  qaReleaseTrainDiffHunks,
  qaReleaseTrainModelVerdictFrom,
  qaReleaseTrainVerdictPrompt,
  qaReleaseTrainVerdictsFrom,
} from "../lib/qaReleaseTrainVerdictCore.ts";

const blob = (c) => `100644 ${c.repeat(40)}`;
const diff = (...hunks) => ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", ...hunks.flatMap((lines) => ["@@ -1 +1 @@", ...lines]), ""].join("\n");
const file = (overrides) => ({ path: "f.ts", post: blob("a"), main: blob("b"), develop: blob("c"), binary: false, ...overrides });
const text = (...lines) => `${lines.join("\n")}\n`;

// The swap a line-set comparison could not see: two functions trade return values.
const SWAP = diff(
  [" function first() {", "-  return true;", "+  return false;", " }"],
  [" function second() {", "-  return false;", "+  return true;", " }"],
);
const BEFORE_SWAP = text("function first() {", "  return true;", "}", "function second() {", "  return false;", "}");
const AFTER_SWAP = text("function first() {", "  return false;", "}", "function second() {", "  return true;", "}");

test("hunks are read by their first character only: a line that looks like a header inside a hunk is content", () => {
  const hunks = qaReleaseTrainDiffHunks(diff([" a context line", "-old line", "++++ looks like a header", "", String.raw`\ No newline at end of file`]));
  assert.deepEqual(hunks, [{ before: ["a context line", "old line"], after: ["a context line", "+++ looks like a header"], removed: ["old line"], added: ["+++ looks like a header"] }]);
});

test("a file main holds as the candidate left it, or a deletion main has too, is on main", () => {
  const { verdict } = qaReleaseTrainContentGap([file({ main: blob("a"), diff: SWAP }), file({ path: "gone.ts", post: null, main: null, develop: null })]);
  assert.equal(verdict.state, "on_main");
});

test("the change in place with other lines around it is on main: main moved on around it (#2591)", () => {
  const main = text("// added by a later release", "function first() {", "  return false;", "}", "", "function second() {", "  return true;", "}", "export {};");
  assert.equal(qaReleaseTrainContentGap([file({ diff: SWAP, mainText: main, developText: AFTER_SWAP })]).verdict.state, "on_main");
});

test("main lacking a swap of lines it holds elsewhere differs: the hunk is found whole or not at all", () => {
  const { verdict, gap } = qaReleaseTrainContentGap([file({ diff: SWAP, mainText: BEFORE_SWAP, developText: AFTER_SWAP })]);
  assert.equal(verdict.state, "differs");
  assert.deepEqual(gap, [{ path: "f.ts", missing: ["  return false;", "  return true;"], leftOnMain: ["  return true;", "  return false;"] }]);
});

test("a hunk develop changed again since is unconfirmed and marked, never read line by line", () => {
  const change = diff([" const config = {", "-  mode: 'a',", "+  mode: 'b',", "+  retries: 3,", " };"]);
  // develop later renamed `mode` again; main has `retries` too, elsewhere in the file.
  const developText = text("const config = {", "  mode: 'c',", "  retries: 3,", "  timeout: 5,", "};");
  const { gap } = qaReleaseTrainContentGap([file({ diff: change, mainText: text("const config = {", "  mode: 'c',", "  retries: 3,", "};"), developText })]);
  assert.deepEqual(gap, [{ path: "f.ts", missing: ["  mode: 'b',", "  retries: 3,"], leftOnMain: ["  mode: 'a',"], changedSince: true }]);
  // main holding develop's file as it is now has nothing of this file left to receive.
  assert.equal(qaReleaseTrainContentGap([file({ diff: change, main: blob("c"), develop: blob("c") })]).verdict.state, "on_main");
});

test("a short change (`10,` -> `20,`) not found in place differs, though main holds `20,` elsewhere", () => {
  const change = diff([" const limits = [", "-  10,", "+  20,", " ];"]);
  const { gap } = qaReleaseTrainContentGap([
    file({ diff: change, mainText: text("const limits = [", "  10,", "];", "const other = [", "  20,", "];"), developText: text("const limits = [", "  20,", "];") }),
  ]);
  assert.deepEqual(gap, [{ path: "f.ts", missing: ["  20,"], leftOnMain: ["  10,"] }]);
});

test("a removal main has not taken differs, even where main changed the line before it", () => {
  const change = diff([" export const a = 1;", "-dangerousCall();", " export const b = 2;"]);
  const developText = text("export const a = 1;", "export const b = 2;");
  const kept = qaReleaseTrainContentGap([file({ diff: change, mainText: text("export const a = 1;", "dangerousCall();", "export const b = 2;"), developText })]);
  assert.deepEqual(kept.gap, [{ path: "f.ts", missing: [], leftOnMain: ["dangerousCall();"] }]);
  const moved = qaReleaseTrainContentGap([file({ diff: change, mainText: text("export const a = 9;", "dangerousCall();", "export const b = 2;"), developText })]);
  assert.equal(moved.verdict.state, "differs");
  // A deleted file main still has differs; one main no longer has is on main.
  const deletion = ["diff --git a/f.ts b/f.ts", "deleted file mode 100644", "--- a/f.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-export const gone = 1;", ""].join("\n");
  assert.equal(qaReleaseTrainContentGap([file({ post: null, diff: deletion, main: null, develop: null })]).verdict.state, "on_main");
  assert.equal(qaReleaseTrainContentGap([file({ post: null, diff: deletion, mainText: text("export const gone = 1;"), develop: null, developText: null })]).verdict.state, "differs");
});

test("whitespace is compared exactly: an indentation change main lacks differs", () => {
  const change = diff([" if ready:", "     start()", "-    finish()", "+finish()"]);
  const main = text("if ready:", "    start()", "    finish()", "", "print(1)", "finish()");
  const { gap } = qaReleaseTrainContentGap([file({ diff: change, mainText: main, developText: text("if ready:", "    start()", "finish()") })]);
  assert.deepEqual(gap, [{ path: "f.ts", missing: ["finish()"], leftOnMain: ["    finish()"] }]);
});

test("a mode the candidate set that main lacks differs, though every text hunk is on main", () => {
  const change = diff([" #!/bin/sh", "-echo old", "+echo new"]);
  const { gap } = qaReleaseTrainContentGap([
    file({ post: `100755 ${"a".repeat(40)}`, main: `100644 ${"b".repeat(40)}`, develop: `100755 ${"c".repeat(40)}`, diff: change, mainText: text("#!/bin/sh", "echo new"), developText: text("#!/bin/sh", "echo new", "exit 0") }),
  ]);
  assert.deepEqual(gap, [{ path: "f.ts", missing: [], leftOnMain: [], modeDiffers: true }]);
});

test("one run of main's lines never stands for two hunks: two identical changes need two places, in order", () => {
  const twice = diff([" const a = 1;", "-run(old);", "+run(next);", " const b = 2;"], [" const a = 1;", "-run(old);", "+run(next);", " const b = 2;"]);
  const once = text("const a = 1;", "run(next);", "const b = 2;", "", "const a = 1;", "run(old);", "const b = 2;");
  const both = text("const a = 1;", "run(next);", "const b = 2;", "", "const a = 1;", "run(next);", "const b = 2;");
  assert.equal(qaReleaseTrainContentGap([file({ diff: twice, mainText: once, developText: both })]).verdict.state, "differs");
  assert.equal(qaReleaseTrainContentGap([file({ diff: twice, mainText: both, developText: both })]).verdict.state, "on_main");
});

test("an emptied file is not on a main without the path, and a final newline change is unconfirmed", () => {
  const emptied = ["diff --git a/__init__.py b/__init__.py", "--- a/__init__.py", "+++ b/__init__.py", "@@ -1 +0,0 @@", "-x = 1", ""].join("\n");
  assert.equal(qaReleaseTrainContentGap([file({ diff: emptied, main: null, mainText: null, developText: "" })]).verdict.state, "differs");
  assert.equal(qaReleaseTrainContentGap([file({ diff: emptied, mainText: "", developText: "" })]).verdict.state, "on_main");
  const newline = diff(["-export const a = 1;", String.raw`\ No newline at end of file`, "+export const a = 1;"]);
  assert.equal(qaReleaseTrainContentGap([file({ diff: newline, mainText: "export const a = 1;", developText: text("export const a = 1;") })]).verdict.state, "differs");
});

test("a deleted file that main keeps as an empty file differs", () => {
  const deletion = ["diff --git a/f.ts b/f.ts", "deleted file mode 100644", "--- a/f.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-export const gone = 1;", ""].join("\n");
  assert.equal(qaReleaseTrainContentGap([file({ post: null, diff: deletion, mainText: "", develop: null })]).verdict.state, "differs");
});

test("a binary file, or one with no hunk to read (a mode change), that matches neither the change nor develop differs", () => {
  const differs = qaReleaseTrainContentGap([file({ path: "e2e/x.png", binary: true, develop: blob("a") })]);
  assert.deepEqual(differs.gap, [{ path: "e2e/x.png", missing: [], leftOnMain: [], binary: true }]);
  assert.equal(qaReleaseTrainContentGap([file({ path: "e2e/x.png", binary: true, main: blob("c") })]).verdict.state, "on_main");
  assert.equal(qaReleaseTrainContentGap([file({ post: `100755 ${"a".repeat(40)}`, main: `100644 ${"a".repeat(40)}`, diff: "diff --git a/f.ts b/f.ts\nold mode 100644\nnew mode 100755\n" })]).verdict.state, "differs");
});

const question = (overrides = {}) => ({
  number: 2696,
  title: "Bind U21 AMUX candidate",
  body: "Adds the U21 candidate path.",
  mergedAt: "2026-10-18T15:04:00Z",
  verdict: { state: "differs", lines: 10, missing: 9, leftOnMain: 1, files: [{ path: "lib/u21.ts", lines: 10 }], fileCount: 1 },
  gap: [{ path: "lib/u21.ts", missing: ["export const u21 = true;"], leftOnMain: ["export const old = 1;"] }],
  mainPulls: [{ number: 2856, title: "Release: Auto router improvement agent", body: "Develop's chat-unified-optimizer is not on main and is not added." }],
  ...overrides,
});

test("the prompt carries the description, the difference and the main pull requests, within its budget", () => {
  const prompt = qaReleaseTrainVerdictPrompt(question());
  assert.match(prompt, /#2696: Bind U21 AMUX candidate/);
  assert.match(prompt, /\+ export const u21 = true;/);
  assert.match(prompt, /- export const old = 1;/);
  assert.match(prompt, /#2856: Release: Auto router improvement agent/);
  const huge = qaReleaseTrainVerdictPrompt(
    question({ gap: Array.from({ length: 400 }, (_, i) => ({ path: `lib/f${i}.ts`, missing: Array.from({ length: 80 }, (_, j) => `export const v${j} = "${"x".repeat(60)}";`), leftOnMain: [] })) }),
  );
  assert.ok(huge.length <= QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS);
  assert.match(huge, /more file\(s\) not shown/);
  assert.match(huge, /\+ \.\.\. 20 more/);
});

test("the model's answer is kept only with a known decision, both reasons and evidence it was shown", () => {
  const answer = { decision: "not_needed", why_ko: "  #2856이 일부러 뺀 경로입니다. ", why_en: "Release #2856 left it out on purpose.", evidence: [2856, 2856] };
  assert.deepEqual(qaReleaseTrainModelVerdictFrom(answer, [2696, 2856]), {
    decision: "not_needed",
    why: { ko: "#2856이 일부러 뺀 경로입니다.", en: "Release #2856 left it out on purpose." },
    evidence: [2856],
  });
  // Citing a pull request it was not shown: the operator decides.
  assert.equal(qaReleaseTrainModelVerdictFrom({ ...answer, evidence: [9999] }, [2696, 2856])?.decision, "operator");
  assert.equal(qaReleaseTrainModelVerdictFrom({ ...answer, decision: "ship" }, [2856]), null);
  assert.equal(qaReleaseTrainModelVerdictFrom({ ...answer, why_ko: "" }, [2856]), null);
  assert.equal(qaReleaseTrainModelVerdictFrom(null, [2856]), null);
});

test("stored verdicts parse, dropping what is malformed", () => {
  assert.equal(qaReleaseTrainVerdictsFrom({ at: "x", verdicts: [] }), null);
  const parsed = qaReleaseTrainVerdictsFrom({ mainSha: blob("a"), at: "2026-10-29T03:00:00Z", verdicts: [{ number: 1, content: { state: "on_main", lines: 2 } }, { number: "2" }] });
  assert.deepEqual(parsed?.verdicts.map((v) => v.number), [1]);
});

test("Admin reads a candidate the content check found on main as on main, and the rest with their verdict", () => {
  const candidate = (number, status) => ({ number, title: `#${number}`, author: "a", mergedAt: "2026-10-20T00:00:00Z", status, mainPullRequest: null });
  const MAIN = "a".repeat(40);
  const verdicts = [
    { number: 1, content: { state: "on_main", lines: 4 }, mainSha: MAIN },
    { number: 2, content: { state: "differs", lines: 3, missing: 3, leftOnMain: 0, files: [{ path: "a", lines: 3 }], fileCount: 1 }, model: { decision: "release", why: { ko: "가", en: "a" }, evidence: [] }, mainSha: MAIN },
    // A workflow change keeps its status: the train cannot carry it anyway.
    { number: 3, content: { state: "on_main", lines: 1 }, mainSha: MAIN },
    // Already on main by GitHub's records: untouched.
    { number: 4, content: { state: "differs", lines: 1, missing: 1, leftOnMain: 0, files: [], fileCount: 1 }, mainSha: MAIN },
    // Checked against an older main (a round's deadline skipped it): not shown.
    { number: 6, content: { state: "on_main", lines: 1 }, mainSha: "b".repeat(40) },
  ];
  const out = qaReleaseTrainWithContentVerdicts(
    [candidate(1, "available"), candidate(2, "mentioned"), candidate(3, "changes_workflows"), candidate(4, "on_main"), candidate(5, "available"), candidate(6, "available")],
    verdicts,
    MAIN,
  );
  assert.deepEqual(
    out.map((c) => [c.number, c.status, c.foundByContent ?? false, c.verdict?.content.state ?? null]),
    [
      [1, "on_main", true, "on_main"],
      [2, "mentioned", false, "differs"],
      [3, "changes_workflows", false, "on_main"],
      [4, "on_main", false, null],
      [5, "available", false, null],
      [6, "available", false, null],
    ],
  );
});
