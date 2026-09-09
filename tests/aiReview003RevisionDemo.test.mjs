// The 003 revision demonstration, exercised as a script.
//
// Two things about it cannot be checked by reading it. The first is that a
// run which throws still removes the temporary directory it created: cleanup
// used to sit on the success path only, so a failing step left a synthetic
// judgement record behind under `/tmp`. The second is that its two refusal
// states stay distinguishable -- a stale artifact fails verification, while a
// re-scored refusal verifies with nothing to report and is refused on
// eligibility alone. Collapsing those two would make the demo say either that
// a refusal counts or that a refusal is a broken file.
//
// No provider is called and the candidate file is opened read-only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

const run = (env = {}) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/experiments/ai-review-003-revision-demo.mjs",
    ],
    { encoding: "utf8", env: { ...process.env, ...env } }
  );

/** The directory the run named for itself, so the test never guesses at one. */
const workingDirectory = (stdout) => {
  const match = /작업 디렉터리: (\S+)/.exec(stdout);
  assert.ok(match, `the run did not name its working directory:\n${stdout}`);
  return match[1];
};

test("a failing run removes the directory it created", async (t) => {
  // Both sides of the try: before anything is scored, and after an artifact
  // exists. The second is the one that leaves the most behind.
  for (const step of ["after-inputs", "after-artifact"]) {
    await t.test(step, () => {
      const result = run({ AI_REVIEW_003_DEMO_FAIL_AT: step });
      assert.notEqual(result.status, 0, "the injected failure did not fail the run");
      assert.match(result.stderr, /injected failure at/);
      const root = workingDirectory(result.stdout);
      assert.equal(
        existsSync(root),
        false,
        `${root} survived a run that threw at ${step}`
      );
    });
  }
});

test("the demonstration runs, and keeps its two refusals apart", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;

  // The stale artifact: files disagree, so integrity fails.
  const stale = /--- \(가\)[\s\S]*?--- \(나\)/.exec(out)?.[0] ?? "";
  assert.match(stale, /무결성 problems\s+1/);
  assert.match(stale, /집계 적격\s+아니오/);

  // Re-scoring is not a way round it: the CLI refuses and writes nothing.
  const rescored = /--- \(나\)[\s\S]*?--- \(다\)/.exec(out)?.[0] ?? "";
  assert.match(rescored, /CLI 종료 코드\s+1/);
  assert.match(rescored, /artifact\.json\s+다시 쓰이지 않았다/);

  // And the refusal recorded as an artifact: integrity passes with nothing to
  // report, and eligibility is what refuses it.
  const refusal = /--- \(다\)[\s\S]*?\(가\)와 \(다\)는/.exec(out)?.[0] ?? "";
  assert.match(refusal, /outcome\.scored\s+false/);
  assert.match(refusal, /무결성 problems\s+0/);
  assert.match(refusal, /집계 적격\s+아니오/);
  assert.match(refusal, /the case is not scored/);

  // And the run left nothing behind on the path that succeeds either.
  assert.equal(existsSync(workingDirectory(out)), false);
  assert.match(out, /후보 파일\s+변경 없음/);
});
