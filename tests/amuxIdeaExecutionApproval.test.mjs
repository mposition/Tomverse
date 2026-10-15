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

test("the screen offers one execution approval when an admissible price exists, and reads back instead of re-posting", () => {
  const panel = readFileSync("components/admin/AmuxFrontierModelsPanel.tsx", "utf8");
  const action = panel.slice(panel.indexOf("const approveExecution = async"), panel.indexOf("const confirmPreview = async"));
  assert.match(action, /\/api\/admin\/amux\/ideas\/execution-approval/);
  assert.match(action, /reserveConfirmationAttempt\(/, "an attempt is recorded before the request, so a reload cannot post twice");
  assert.equal((action.match(/adminFetch\(/g) ?? []).length, 1, "one request, never a retry");
  assert.match(action, /await readConfirmation\(value\.previewId/);
  assert.match(panel, /row\.status === "approved" &&\s*row\.admissible === true/);
  // Without an admissible price the separate confirmation stays; never both buttons at once.
  assert.match(panel, /confirmation\.kind === "idle" && executionPriceId \?/);
  assert.match(panel, /confirmation\.kind === "idle" && executionPrice\.kind === "none" \?/);
  // Loading and a failed read offer no button at all; the ceiling is shown beside the approval.
  assert.match(panel, /executionPrice\.kind === "loading" \?/);
  assert.match(panel, /executionPrice\.kind === "error" \?/);
  assert.match(panel, /<p>\{budgetMessages\.price\}<\/p>/);
  // A 409 refusal records nothing: its reason is shown and the attempt cleared.
  assert.match(action, /response\.status === 409/);
  assert.match(action, /monthly_cap_exceeded/);
});

test("both admin locales describe the execution approval", () => {
  const messages = readFileSync("lib/adminMessages/amuxIdeaInput.ts", "utf8");
  assert.equal((messages.match(/executionApprovalAction:/g) ?? []).length, 2);
  assert.equal((messages.match(/executionApprovalBoundary:/g) ?? []).length, 2);
});
