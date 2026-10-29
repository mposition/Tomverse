import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseTrainWithContentVerdicts } from "../lib/qaReleaseTrainCargoCore.ts";
import {
  QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS,
  qaReleaseTrainContentGap,
  qaReleaseTrainDiffLines,
  qaReleaseTrainModelVerdictFrom,
  qaReleaseTrainVerdictPrompt,
  qaReleaseTrainVerdictsFrom,
} from "../lib/qaReleaseTrainVerdictCore.ts";

const blob = (c) => c.repeat(40);

const DIFF = [
  "diff --git a/lib/a.ts b/lib/a.ts",
  "--- a/lib/a.ts",
  "+++ b/lib/a.ts",
  "@@ -1,2 +1,2 @@",
  "-export const limit = 10;",
  "+export const limit = 20;",
  "+}",
  "diff --git a/lib/gone.ts b/lib/gone.ts",
  "--- a/lib/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const gone = true;",
  "",
].join("\n");

test("a diff's added and removed lines are read by file, a deleted file under its old name", () => {
  const files = qaReleaseTrainDiffLines(DIFF);
  assert.deepEqual(files.get("lib/a.ts"), { added: ["export const limit = 20;", "}"], removed: ["export const limit = 10;"] });
  assert.deepEqual(files.get("lib/gone.ts"), { added: [], removed: ["export const gone = true;"] });
});

test("a file main holds as the candidate left it, or a deletion main has too, is on main", () => {
  const { verdict, gap } = qaReleaseTrainContentGap(DIFF, [
    { path: "lib/a.ts", post: blob("a"), main: blob("a"), develop: blob("b"), binary: false },
    { path: "lib/gone.ts", post: null, main: null, develop: null, binary: false },
  ]);
  // A bare `}` proves nothing and is not counted.
  assert.deepEqual(verdict, { state: "on_main", lines: 3 });
  assert.deepEqual(gap, []);
});

test("the same lines under another blob are on main: main moved on around them (#2591)", () => {
  const { verdict } = qaReleaseTrainContentGap(DIFF, [
    {
      path: "lib/a.ts",
      post: blob("a"),
      main: blob("c"),
      develop: blob("d"),
      binary: false,
      mainText: "export const other = 1;\nexport const limit = 20;\n",
      developText: "export const limit = 20;\n",
    },
    { path: "lib/gone.ts", post: null, main: null, develop: null, binary: false },
  ]);
  assert.equal(verdict.state, "on_main");
});

test("what main lacks and develop keeps is missing; what develop changed again since is not counted", () => {
  const { verdict, gap } = qaReleaseTrainContentGap(DIFF, [
    {
      path: "lib/a.ts",
      post: blob("a"),
      main: blob("c"),
      develop: blob("d"),
      binary: false,
      mainText: "export const limit = 10;\n",
      developText: "export const limit = 20;\n",
    },
    // main still has the file; develop later brought it back, so its removal is another pull request's business.
    { path: "lib/gone.ts", post: null, main: blob("e"), develop: blob("e"), binary: false, mainText: "export const gone = true;\n", developText: "export const gone = true;\n" },
  ]);
  assert.deepEqual(verdict, {
    state: "differs",
    lines: 3,
    missing: 1,
    leftOnMain: 1,
    files: [{ path: "lib/a.ts", lines: 2 }],
    fileCount: 1,
  });
  assert.deepEqual(gap, [{ path: "lib/a.ts", missing: ["export const limit = 20;"], leftOnMain: ["export const limit = 10;"] }]);
});

test("a line develop no longer has is not missing: a later pull request replaced it", () => {
  const { verdict } = qaReleaseTrainContentGap(DIFF, [
    { path: "lib/a.ts", post: blob("a"), main: blob("c"), develop: blob("d"), binary: false, mainText: "export const limit = 30;\n", developText: "export const limit = 30;\n" },
    { path: "lib/gone.ts", post: null, main: null, develop: null, binary: false },
  ]);
  assert.equal(verdict.state, "on_main");
});

test("a binary file that differs from main is missing unless main already matches develop", () => {
  const binary = "diff --git a/e2e/x.png b/e2e/x.png\nBinary files a/e2e/x.png and b/e2e/x.png differ\n";
  const differs = qaReleaseTrainContentGap(binary, [{ path: "e2e/x.png", post: blob("a"), main: blob("b"), develop: blob("a"), binary: true }]);
  assert.equal(differs.verdict.state, "differs");
  assert.deepEqual(differs.gap, [{ path: "e2e/x.png", missing: [], leftOnMain: [], binary: true }]);
  const rerecorded = qaReleaseTrainContentGap(binary, [{ path: "e2e/x.png", post: blob("a"), main: blob("c"), develop: blob("c"), binary: true }]);
  assert.equal(rerecorded.verdict.state, "on_main");
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
  const verdicts = [
    { number: 1, content: { state: "on_main", lines: 4 } },
    { number: 2, content: { state: "differs", lines: 3, missing: 3, leftOnMain: 0, files: [{ path: "a", lines: 3 }], fileCount: 1 }, model: { decision: "release", why: { ko: "가", en: "a" }, evidence: [] } },
    // A workflow change keeps its status: the train cannot carry it anyway.
    { number: 3, content: { state: "on_main", lines: 1 } },
    // Already on main by GitHub's records: untouched.
    { number: 4, content: { state: "differs", lines: 1, missing: 1, leftOnMain: 0, files: [], fileCount: 1 } },
  ];
  const out = qaReleaseTrainWithContentVerdicts(
    [candidate(1, "available"), candidate(2, "mentioned"), candidate(3, "changes_workflows"), candidate(4, "on_main"), candidate(5, "available")],
    verdicts,
  );
  assert.deepEqual(
    out.map((c) => [c.number, c.status, c.foundByContent ?? false, c.verdict?.content.state ?? null]),
    [
      [1, "on_main", true, "on_main"],
      [2, "mentioned", false, "differs"],
      [3, "changes_workflows", false, "on_main"],
      [4, "on_main", false, null],
      [5, "available", false, null],
    ],
  );
});
