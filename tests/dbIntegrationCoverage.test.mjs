import assert from "node:assert/strict";
import test from "node:test";
import { auditDbIntegrationCoverage } from "../scripts/check-db-integration-coverage-core.mjs";

const runnerWith = (...paths) =>
  paths.map((path) => `    "${path}",\n`).join("");

test("a runner and a directory that agree pass", () => {
  const { failures, referenced } = auditDbIntegrationCoverage({
    suiteFiles: ["a.db.test.ts", "b.db.test.ts"],
    runnerSource: runnerWith(
      "tests/integration/a.db.test.ts",
      "tests/integration/b.db.test.ts"
    ),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(referenced, [
    "tests/integration/a.db.test.ts",
    "tests/integration/b.db.test.ts",
  ]);
});

test("a suite the runner never names is reported as never run", () => {
  // The actual regression: provider-probe.db.test.ts was written, never
  // listed, and silently rotted until something else made it fail.
  const { failures } = auditDbIntegrationCoverage({
    suiteFiles: ["a.db.test.ts", "orphan.db.test.ts"],
    runnerSource: runnerWith("tests/integration/a.db.test.ts"),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /orphan\.db\.test\.ts/);
  assert.match(failures[0], /never run it/);
});

test("a path the runner names but that no longer exists is reported too", () => {
  const { failures } = auditDbIntegrationCoverage({
    suiteFiles: ["a.db.test.ts"],
    runnerSource: runnerWith(
      "tests/integration/a.db.test.ts",
      "tests/integration/renamed.db.test.ts"
    ),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /renamed\.db\.test\.ts/);
  assert.match(failures[0], /does not exist/);
});

test("both directions are reported in one run, not one at a time", () => {
  const { failures } = auditDbIntegrationCoverage({
    suiteFiles: ["a.db.test.ts", "orphan.db.test.ts"],
    runnerSource: runnerWith("tests/integration/gone.db.test.ts"),
  });
  assert.equal(failures.length, 3);
});

test("a suite named more than once is still named once", () => {
  // Several files legitimately appear in their own `node --test` process, and
  // a duplicate mention must not read as a second suite.
  const { failures, referenced } = auditDbIntegrationCoverage({
    suiteFiles: ["a.db.test.ts"],
    runnerSource:
      runnerWith("tests/integration/a.db.test.ts") +
      runnerWith("tests/integration/a.db.test.ts"),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(referenced, ["tests/integration/a.db.test.ts"]);
});

test("only .db.test.ts paths count, so a helper mention is not coverage", () => {
  const { referenced } = auditDbIntegrationCoverage({
    suiteFiles: [],
    runnerSource: '"tests/integration/helpers.ts"\n"tests/integration/a.db.test"',
  });
  assert.deepEqual(referenced, []);
});
