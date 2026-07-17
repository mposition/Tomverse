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

const result = spawnSync(
  process.execPath,
  ["--conditions=react-server", "--import", "tsx", "--test", ...tests],
  { stdio: "inherit", env: process.env }
);
process.exit(result.status ?? 1);
