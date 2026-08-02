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
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testsDirectory = join(process.cwd(), "tests", "server-contract");
const tests = readdirSync(testsDirectory)
  .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(testsDirectory, name));

if (tests.length === 0) {
  throw new Error("No server contract tests were found.");
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
    ...tests,
  ],
  { stdio: "inherit", env: process.env }
);
process.exit(result.status ?? 1);
