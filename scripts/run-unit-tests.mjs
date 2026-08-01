import { readdirSync } from "node:fs";
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
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    ...tests,
  ],
  { stdio: "inherit", env: process.env }
);
process.exit(result.status ?? 1);
