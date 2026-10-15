import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the approval observer records an approval before the merge and completes the card only after one", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/engineeringAgentPrObserverHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the observer route is the runner's, behind the whole adapter gate, and takes no evidence from its caller", () => {
  const route = readFileSync("app/api/internal/engineering-agent/observe/pull-requests/route.ts", "utf8");
  const gate = 'if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);';
  assert.ok(route.includes('isEngineeringAgentRouteAuthorized(request, "runner")'));
  assert.ok(route.includes(gate));
  assert.ok(route.indexOf(gate) < route.indexOf("readLimitedJson("));
  assert.match(route, /z\.object\(\{\}\)\.strict\(\)/);
});
