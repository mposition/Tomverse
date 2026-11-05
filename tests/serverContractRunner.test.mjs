import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Drives scripts/run-server-contract-tests.mjs against a scratch project. The
// `tsx` here is a stand-in package, so nothing in this scratch directory links
// to the shared node_modules and removing it cannot reach through a junction.

const RUNNER = fileURLToPath(new URL("../scripts/run-server-contract-tests.mjs", import.meta.url));

const RECORDING_TEST = `
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
appendFileSync(
  process.env.RUNNER_TEST_LOG,
  JSON.stringify({ file: basename(process.argv[1]), execArgv: process.execArgv }) + "\\n"
);
`;

function withProject(files, assertions) {
  const root = mkdtempSync(join(tmpdir(), "server-contract-runner-"));
  try {
    const stubTsx = join(root, "node_modules", "tsx");
    mkdirSync(stubTsx, { recursive: true });
    writeFileSync(join(stubTsx, "package.json"), '{"name":"tsx","main":"index.mjs"}');
    writeFileSync(join(stubTsx, "index.mjs"), "");

    const testsDirectory = join(root, "tests", "server-contract");
    mkdirSync(join(testsDirectory, "nested"), { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(testsDirectory, name), source);
    }

    const log = join(root, "ran.log");
    const env = { ...process.env, RUNNER_TEST_LOG: log };
    // The outer test run's context would make the inner runner report to it.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [RUNNER], { cwd: root, env, encoding: "utf8" });
    const ran = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
    assertions(result, ran);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("runs exactly the direct .test.ts and .test.mjs children, with the runner's flags", () => {
  withProject(
    {
      "a.test.mjs": RECORDING_TEST,
      "b.test.ts": RECORDING_TEST,
      "helper.ts": RECORDING_TEST,
      "nested/c.test.mjs": RECORDING_TEST,
    },
    (result, ran) => {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(ran.map((entry) => entry.file).sort(), ["a.test.mjs", "b.test.ts"]);
      for (const { execArgv } of ran) {
        assert.ok(execArgv.includes("--conditions=react-server"), execArgv.join(" "));
        assert.ok(execArgv.includes("--experimental-test-module-mocks"), execArgv.join(" "));
        assert.equal(execArgv[execArgv.indexOf("--import") + 1], "tsx", execArgv.join(" "));
      }
    }
  );
});

test("passes a failing test's exit code on", () => {
  withProject(
    { "fails.test.mjs": 'import test from "node:test"; test("fails", () => { throw new Error("x"); });' },
    (result) => assert.equal(result.status, 1)
  );
});

test("reports an empty directory instead of passing", () => {
  withProject({}, (result) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No server contract tests were found\./);
  });
});

test("refuses a file name a glob would not select, without running anything", () => {
  withProject({ "a.test.mjs": RECORDING_TEST, "b[1].test.mjs": RECORDING_TEST }, (result, ran) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /b\[1\]\.test\.mjs/);
    assert.deepEqual(ran, []);
  });
});
