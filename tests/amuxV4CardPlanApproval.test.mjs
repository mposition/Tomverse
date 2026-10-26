import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const harness = (file) => spawnSync(process.execPath, [
  "--experimental-test-module-mocks", "--conditions=react-server", "--import", "tsx", resolve(file),
], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });

test("one plan approval prepares and consumes every card in one transaction, Stories first, Tasks in dependency order", () => {
  const child = harness("tests/support/amuxV4CardPlanApprovalHarness.mjs");
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the real card duplicate scanner admits the plan's own new cards and nothing else", () => {
  const child = harness("tests/support/amuxCardDuplicateScannerHarness.mjs");
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the card plan route keeps the single routes' checks, and the single prepare runs the same preparation", () => {
  const route = readFileSync("app/api/admin/amux/ideas/unit-decisions/cards/plan/route.ts", "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner" \|\| !hasValidMutationOrigin\(request\)/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /amuxV4UnitWriteEnabled\(process\.env\[AMUX_V4_UNIT_WRITE_ENV\]\)/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /\.strict\(\)/);
  const single = readFileSync("lib/amux/ideaStoryRegistrationService.ts", "utf8");
  assert.match(single.slice(single.indexOf("export async function prepareAmuxV4CardRegistration(input")),
    /prepareAmuxV4CardRegistrationInTx\(tx,/);
  const plan = readFileSync("lib/amux/ideaCardPlanApprovalService.ts", "utf8");
  assert.equal((plan.match(/prisma\.\$transaction\(/g) ?? []).length, 1);
  assert.ok(plan.indexOf("commitAmuxV4CardRegistration(tx,") < plan.indexOf("scanner.admitCreated(tx,"));
});

test("single and whole-plan Task costs use the deterministic final grade at prepare and consume", () => {
  const single = readFileSync("lib/amux/ideaStoryRegistrationService.ts", "utf8");
  assert.match(single,
    /finalTaskGrade = verified\.proposal\.cardType === "task" \?[\s\S]*requireAmuxV20TaskGrade\(verified\.proposal,[\s\S]*analysisPreviewId: verified\.previewId/);
  assert.match(single,
    /calculateCurrentApprovedAmuxV4TaskCost\(tx,[\s\S]*verified\.proposal\.taskRole, finalTaskGrade!\)/);
  const recalculate = single.slice(single.indexOf("const recalculate = async"));
  assert.ok(recalculate.indexOf("requireAmuxV20TaskGrade(verified.proposal,") <
    recalculate.indexOf("calculateCurrentApprovedAmuxV4TaskCost(transaction"));
  assert.doesNotMatch(recalculate,
    /calculateCurrentApprovedAmuxV4TaskCost\([\s\S]{0,160}proposal\.executionGrade/);

  const plan = readFileSync("lib/amux/ideaCardPlanApprovalService.ts", "utf8");
  const planRecalculate = plan.slice(plan.indexOf("recalculate: async (transaction)"));
  assert.ok(planRecalculate.indexOf("inspectAmuxV20TaskRegistration(proposal)") <
    planRecalculate.indexOf("calculateCurrentApprovedAmuxV4TaskCost(transaction"));
  assert.match(planRecalculate,
    /calculateCurrentApprovedAmuxV4TaskCost\(transaction,[\s\S]*proposal\.taskRole, inspected\.executionGrade\)/);
});
