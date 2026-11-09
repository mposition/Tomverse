import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("a merged or closed pull request frees its owner queue slot once its branch is gone", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/engineeringAgentBindingReleaseHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the observer route releases bindings after the approval observer records its merges", () => {
  const route = readFileSync("app/api/internal/engineering-agent/observe/pull-requests/route.ts", "utf8");
  const observe = route.indexOf("await observeEngineeringAgentPullRequests()");
  const release = route.indexOf("await releaseEngineeringAgentBindings()");
  assert.ok(observe > 0 && release > observe);
});

test("the branch read accepts only the agent's own branch names", () => {
  const source = readFileSync("lib/engineeringAgentGitHubRead.ts", "utf8");
  assert.match(source, /\^agent\\\/engineering\\\/\[0-9\]\{1,20\}\$/);
  assert.match(source, /record\(entry\)\?\.ref === `refs\/heads\/\$\{ref\}`/);
});
