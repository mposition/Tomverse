import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("one plan approval prepares and consumes every node in one transaction, parents first", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxV4NodePlanApprovalHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the real duplicate scanner admits the plan's own new nodes and nothing else", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxNodeDuplicateScannerHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the node plan route keeps the single routes' owner, origin, step-up and switch checks", () => {
  const route = readFileSync("app/api/admin/amux/ideas/unit-decisions/nodes/plan/route.ts", "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner" \|\| !hasValidMutationOrigin\(request\)/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /amuxV4UnitWriteEnabled\(process\.env\[AMUX_V4_UNIT_WRITE_ENV\]\)/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /\.strict\(\)/);
});

test("the single prepare route and the plan run the same preparation", () => {
  const service = readFileSync("lib/amux/ideaNodeRegistrationService.ts", "utf8");
  const single = service.slice(service.indexOf("export async function prepareAmuxV4NodeCreation(input"));
  assert.match(single, /prepareAmuxV4NodeCreationInTx\(tx,/);
  const plan = readFileSync("lib/amux/ideaNodePlanApprovalService.ts", "utf8");
  assert.match(plan, /prepareAmuxV4NodeCreationInTx\(tx,/);
  assert.match(plan, /commitAmuxV4NodeCreation\(tx,/);
  assert.equal((plan.match(/prisma\.\$transaction\(/g) ?? []).length, 1);
});
