import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("one execution approval confirms the transfer and reserves its budget in one transaction", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxIdeaExecutionApprovalHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the execution approval route keeps the confirmation route's owner, step-up, browser and shape checks", () => {
  const route = readFileSync("app/api/admin/amux/ideas/execution-approval/route.ts", "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(route, /ideaExecutionApprovalPermitted\(process\.env\)/);
  assert.match(route, /"application\/json"/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /inspectIdeaTransferConfirmationRequest\(/);
  assert.match(route, /readIdeaTransferBrowserNonce\(/);
  assert.ok(route.indexOf("readIdeaTransferBrowserNonce(") < route.indexOf("approveIdeaExecution(session"),
    "no decision without the preview's browser binding");
  assert.match(route, /\.strict\(\)/);
  assert.doesNotMatch(route, /export async function (GET|PUT|DELETE)/);
});
