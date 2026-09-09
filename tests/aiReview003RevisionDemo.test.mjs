// The 003 revision demonstration, exercised as a script.
//
// Three things about it cannot be checked by reading it. That a run which
// throws still removes the temporary directory it created -- cleanup used to
// sit on the success path only, so a failing step left a synthetic judgement
// record behind. That the re-scoring CLI really writes nothing, rather than
// happening to leave one field alone. And that its two refusal states stay
// distinguishable: a stale artifact fails verification, while a re-scored
// refusal verifies with nothing to report and is refused on eligibility
// alone. Collapsing those two would make the demo say either that a refusal
// counts or that a refusal is a broken file.
//
// No provider is called and the candidate file is opened read-only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * A parent directory the demo will create its own directory inside, so this
 * test never has to work out which directory the run owned.
 *
 * `os.tmpdir()` reads `TMPDIR`, so pointing the child at a directory this
 * test made is enough: whatever the demo leaves behind is whatever is left in
 * here under its own prefix -- `tsx` puts a cache directory here too, which
 * is not the demo's and is not what this is looking for. The name carries a
 * SPACE deliberately. The cleanup assertion used to
 * parse the path out of the output with `(\S+)`, which cut at the first
 * space -- so on a path like this one it checked that a truncated path was
 * absent, which it always was, while the real directory survived.
 */
const leftBehind = (parent) =>
  readdirSync(parent).filter((name) => name.startsWith("ai-review-003-demo-"));

const withParent = (body) => {
  const parent = mkdtempSync(join(tmpdir(), "003 demo parent-"));
  try {
    return body(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};

const run = (parent, env = {}) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/experiments/ai-review-003-revision-demo.mjs",
    ],
    { encoding: "utf8", env: { ...process.env, TMPDIR: parent, ...env } }
  );

/**
 * The directory the run named for itself, read to the end of its line.
 *
 * Kept alongside the parent-directory check rather than replaced by it: the
 * two disagree if the demo ever names a directory other than the one it
 * works in, and that line is what a person reading the output would go to.
 */
const namedDirectory = (stdout) => {
  const match = /^작업 디렉터리: (.+)$/m.exec(stdout);
  assert.ok(match, `the run did not name its working directory:\n${stdout}`);
  return match[1].trimEnd();
};

test("a failing run removes the directory it created", async (t) => {
  // Both sides of the try: before anything is scored, and after an artifact
  // exists. The second is the one that leaves the most behind.
  for (const step of ["after-inputs", "after-artifact"]) {
    await t.test(step, () => {
      withParent((parent) => {
        const result = run(parent, { AI_REVIEW_003_DEMO_FAIL_AT: step });
        assert.notEqual(result.status, 0, "the injected failure did not fail the run");
        assert.match(result.stderr, /injected failure at/);
        assert.deepEqual(
          leftBehind(parent),
          [],
          `a run that threw at ${step} left its directory in ${parent}`
        );
        assert.equal(existsSync(namedDirectory(result.stdout)), false);
      });
    });
  }
});

test("the re-scoring CLI's refusal is checked as bytes, not as one field", () => {
  withParent((parent) => {
    // A CLI that refuses -- exit 1, like the real one -- and writes anyway,
    // leaving `outcome.scored` true so that a one-field comparison reports
    // the file as untouched. The real script cannot be made to do this, and
    // that is exactly why the check needs an adversary.
    const stub = join(parent, "rescore-stub.mjs");
    writeFileSync(
      stub,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const at = process.argv.indexOf("--dir");',
        'const path = join(process.argv[at + 1], "artifact.json");',
        'const artifact = JSON.parse(readFileSync(path, "utf8"));',
        'artifact.outcome.byKind.missingPoints.truePositives = 999;',
        'writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\\n`, "utf8");',
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8"
    );

    const injected = run(parent, { AI_REVIEW_003_DEMO_RESCORE_CLI: stub });
    assert.equal(injected.status, 0, injected.stderr);
    assert.match(
      injected.stdout,
      /artifact\.json\s+덮어써졌다/,
      "an artifact rewritten with the same `outcome.scored` was reported as untouched"
    );
    assert.doesNotMatch(injected.stdout, /artifact\.json\s+다시 쓰이지 않았다/);
  });
});

test("the demonstration runs, and keeps its two refusals apart", () => {
  withParent((parent) => {
    const result = run(parent);
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;

    // The stale artifact: files disagree, so integrity fails.
    const stale = /--- \(가\)[\s\S]*?--- \(나\)/.exec(out)?.[0] ?? "";
    assert.match(stale, /무결성 problems\s+1/);
    assert.match(stale, /집계 적격\s+아니오/);

    // Re-scoring is not a way round it: the CLI refuses and writes nothing.
    const rescored = /--- \(나\)[\s\S]*?--- \(다\)/.exec(out)?.[0] ?? "";
    assert.match(rescored, /CLI 종료 코드\s+1/);
    assert.match(rescored, /artifact\.json\s+다시 쓰이지 않았다 — 바이트 동일/);

    // And the refusal recorded as an artifact: integrity passes with nothing
    // to report, and eligibility is what refuses it.
    const refusal = /--- \(다\)[\s\S]*?\(가\)와 \(다\)는/.exec(out)?.[0] ?? "";
    assert.match(refusal, /outcome\.scored\s+false/);
    assert.match(refusal, /무결성 problems\s+0/);
    assert.match(refusal, /집계 적격\s+아니오/);
    assert.match(refusal, /the case is not scored/);

    // And the run left nothing behind on the path that succeeds either.
    assert.deepEqual(leftBehind(parent), []);
    assert.equal(existsSync(namedDirectory(out)), false);
    assert.match(out, /후보 파일\s+변경 없음/);
  });
});
