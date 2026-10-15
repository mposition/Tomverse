import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the whole plan approval runs nodes, cards and scores in one transaction", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server", "--import", "tsx",
    resolve("tests/support/amuxV4PlanApprovalHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("each part's own route and the whole plan run the same in-transaction part", () => {
  const node = readFileSync("lib/amux/ideaNodePlanApprovalService.ts", "utf8");
  const card = readFileSync("lib/amux/ideaCardPlanApprovalService.ts", "utf8");
  const score = readFileSync("lib/amux/portfolioPlanApprovalService.ts", "utf8");
  assert.match(node.slice(node.indexOf("export async function approveAmuxV4NodePlan(")), /runAmuxV4NodePlanInTx\(tx, prepared\)/);
  assert.match(card.slice(card.indexOf("export async function approveAmuxV4CardPlan(")), /runAmuxV4CardPlanInTx\(tx, prepared\)/);
  assert.match(score.slice(score.indexOf("export async function approveAmuxV4ScorePlan(")), /runAmuxV4ScorePlanInTx\(tx, prepared\)/);
  const plan = readFileSync("lib/amux/ideaPlanApprovalService.ts", "utf8");
  assert.equal((plan.match(/prisma\.\$transaction\(/g) ?? []).length, 1);
  const route = readFileSync("app/api/admin/amux/ideas/plan/route.ts", "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner" \|\| !hasValidMutationOrigin\(request\)/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /amuxV4UnitWriteEnabled\(process\.env\[AMUX_V4_UNIT_WRITE_ENV\]\)/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /planRequestId: z\.uuid\(\)/);
});
