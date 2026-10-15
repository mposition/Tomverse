import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("one plan approval writes every assessment once and then every Task score in one transaction", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server", "--import", "tsx",
    resolve("tests/support/amuxV4ScorePlanApprovalHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("the single portfolio writers and the plan use the same in-transaction writers", () => {
  const assessment = readFileSync("lib/amux/portfolioAssessmentService.ts", "utf8");
  assert.match(assessment.slice(assessment.indexOf("export async function commitAmuxPortfolioAssessment(")),
    /writeAmuxPortfolioAssessmentInTx\(tx, input\)/);
  const score = readFileSync("lib/amux/portfolioScoreService.ts", "utf8");
  assert.match(score.slice(score.indexOf("export async function commitAmuxPortfolioScore(")),
    /writeAmuxPortfolioScoreInTx\(tx, input\)/);
  // The single path still compares the digest its preview showed; only null skips it.
  assert.match(assessment, /input\.confirmationDigest !== null && plan\.confirmationDigest !== input\.confirmationDigest/);
  assert.match(score, /input\.confirmationDigest !== null && plan\.inputDigest !== input\.confirmationDigest/);
  const route = readFileSync("app/api/admin/amux/portfolio/plan/route.ts", "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner" \|\| !hasValidMutationOrigin\(request\)/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /amuxV4PortfolioWriteEnabled\(process\.env\[AMUX_V4_PORTFOLIO_WRITE_ENV\]\)/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /\.strict\(\)/);
});
