// Runs the @review-parity tier and refuses to pass on a runtime skip.
//
// verify-review-parity-coverage.mjs validates tags through `--list`, which
// cannot see a `test.skip()` inside a beforeEach: a contract can stay tagged,
// stay listed, stay in the manifest, and still never execute. That is not
// hypothetical -- the composer failure-path release lives in a "mobile chat
// keyboard policy" block that skips outside mobile-* projects, so tagging it
// would have added a contract the desktop baseline never ran.
//
// A silently skipped parity test is exactly the baseline shrink the manifest
// exists to prevent, so it fails here instead of reporting green.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT = "desktop-chromium";
const TAG = "@review-parity";

const reportDir = mkdtempSync(path.join(tmpdir(), "review-parity-"));
const reportPath = path.join(reportDir, "report.json");

try {
  const run = spawnSync(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      `--project=${PROJECT}`,
      `--grep=${TAG}`,
      "--reporter=list,json",
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
    }
  );

  let stats;
  try {
    stats = JSON.parse(readFileSync(reportPath, "utf8")).stats ?? {};
  } catch (cause) {
    console.error(`\nFAIL: could not read the parity JSON report: ${cause.message}`);
    process.exit(1);
  }

  const { expected = 0, unexpected = 0, skipped = 0, flaky = 0 } = stats;
  console.log(
    `\n${TAG}: ${expected} passed, ${unexpected} failed, ${flaky} flaky, ${skipped} skipped.`
  );

  if (skipped > 0) {
    console.error(
      `FAIL: ${skipped} parity contract(s) were skipped at runtime in ${PROJECT}.\n` +
        "  A skipped contract is not a baseline. Either the test belongs to a project this tier\n" +
        "  does not run, or a conditional skip was added -- resolve it in the manifest\n" +
        "  (scripts/verify-review-parity-coverage.mjs), do not leave it silently unrun."
    );
    process.exit(1);
  }

  if (expected === 0) {
    console.error(`FAIL: no ${TAG} test executed. The baseline ran nothing.`);
    process.exit(1);
  }

  process.exit(run.status ?? 1);
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
