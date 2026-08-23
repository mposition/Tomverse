import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testsDirectory = join(process.cwd(), "tests");
const tests = readdirSync(testsDirectory)
  .filter((name) => name.endsWith(".test.mjs") || name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(testsDirectory, name));

if (tests.length === 0) {
  throw new Error("No unit tests were found.");
}

/**
 * Client components get their own process, without `--conditions=react-server`.
 *
 * Under that condition `react.createContext` does not exist, so anything that
 * pulls in `lucide-react` -- which is every icon-bearing component in this app
 * -- throws on import before a single assertion runs. The condition is right
 * for the rest of the suite: most of what is tested here is server code, and
 * loading it the way the server loads it is the point.
 *
 * A second process rather than dropping the condition for everything, and
 * rather than a mock: `scripts/run-db-integration-tests.mjs` already splits
 * processes for exactly this reason -- a flag that changes how modules resolve
 * is process-global, so one lane's needs would silently become the other's.
 *
 * This lane exists because the Auto model selection contract
 * (docs/ui-contracts/auto-model-selection.md §1) says what two components must
 * render and nothing could execute that claim: there was no way to load a
 * client component in a test at all.
 */
const clientTestsDirectory = join(testsDirectory, "client");
const clientTests = existsSync(clientTestsDirectory)
  ? readdirSync(clientTestsDirectory)
      .filter((name) => name.endsWith(".test.tsx") || name.endsWith(".test.ts"))
      .sort()
      .map((name) => join(clientTestsDirectory, name))
  : [];

// `spec` rather than the default non-TTY `tap` reporter, for one reason: it
// repeats every failure in a summary block at the *end* of the run.
//
// TAP prints "not ok" inline, wherever the test happened to run. With ~1000
// tests that is thousands of lines up, and the GitHub Actions log API only
// serves a bounded tail -- so a red CI run showed "# fail 1" with no way to
// learn which test, and the file order is not even stable between machines
// (node runs test files concurrently, so numbering shifts run to run). The
// summary makes a truncated log enough to diagnose from.
//
// Nothing parses this output: the workflows and this script only use the exit
// code, which is unchanged.
const result = spawnSync(
  process.execPath,
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--test",
    // PDF worker tests spawn their own parser process. On high-core Windows
    // hosts, running every test file concurrently intermittently terminates
    // that file before it can report an assertion. Serial file execution keeps
    // the mandatory gate deterministic; individual tests inside each file are
    // still free to exercise their own concurrency.
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    ...tests,
  ],
  { stdio: "inherit", env: process.env }
);
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

if (clientTests.length === 0) process.exit(0);

const clientResult = spawnSync(
  process.execPath,
  [
    // No --conditions=react-server here. That is the whole reason this is a
    // second process.
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    ...clientTests,
  ],
  { stdio: "inherit", env: process.env }
);
process.exit(clientResult.status ?? 1);
