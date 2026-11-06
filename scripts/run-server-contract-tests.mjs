// Server-side contract tests for API route handlers.
//
// These run in their own process, separate from `npm run test:unit`, for two
// reasons:
//
//   * they need --experimental-test-module-mocks to put spies on the provider
//     adapter and the credit reservation, and
//   * module mocks are process-global, so running them beside the unit suite
//     would let a mock installed by one file leak into another.
//
// Run files serially because several suites load route handlers while parsing
// PDFs or images. Unbounded worker concurrency makes those tests resource-
// sensitive on high-core CI hosts without adding any coverage.
//
// Each file drives a real route handler and asserts what it did *not* do --
// principally that a rejected chat request never reaches a provider and never
// reserves credits.
//
// Files reach `node --test` as glob patterns because a list of absolute paths
// outgrew the 32,767-character Windows command line from a worktree under
// .claude/worktrees/: spawnSync failed with ENAMETOOLONG before node started.
// scripts/run-unit-tests.mjs explains the same choice at more length.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TESTS_DIRECTORY = "tests/server-contract";
const SUFFIXES = [".test.ts", ".test.mjs"];

// A name a glob would read as something other than itself would silently stop
// running, so it is refused. Same rule as scripts/run-unit-tests.mjs.
const GLOB_SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const names = readdirSync(join(process.cwd(), TESTS_DIRECTORY)).filter((name) =>
  SUFFIXES.some((suffix) => name.endsWith(suffix))
);

if (names.length === 0) {
  throw new Error("No server contract tests were found.");
}

const unsafe = names.filter((name) => !GLOB_SAFE_NAME.test(name));
if (unsafe.length > 0) {
  console.error(
    `Cannot run the server contract tests: rename these files in ${TESTS_DIRECTORY}/ ` +
      "using letters, digits, '.', '_' and '-', because a glob pattern would not " +
      `select them: ${unsafe.join(", ")}`
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    ...SUFFIXES.map((suffix) => `${TESTS_DIRECTORY}/*${suffix}`),
  ],
  { stdio: "inherit", env: process.env }
);

// A spawn that never started has `status: null`; without this it would exit 1
// having printed nothing.
if (result.error) {
  console.error(`The server contract tests never started: ${result.error.message}`);
}
process.exit(result.status ?? 1);
