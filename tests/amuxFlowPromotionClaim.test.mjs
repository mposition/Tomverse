import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// AMUX process audit bundle 3 (owner decision 2026-11-14, AMUXFLOW/B3):
// promotion folded into the claim. Off by default.

test("the promotion flow switch is off unless exactly enabled", async () => {
  const core = await import("../lib/amux/v22AutoPromotionCore.ts");
  assert.equal(core.amuxV22PromotionFlowEnabled(undefined), false);
  assert.equal(core.amuxV22PromotionFlowEnabled("true"), false);
  assert.equal(core.amuxV22PromotionFlowEnabled("enabled"), true);
  assert.ok(core.AMUX_V22_PROMOTIONS_PER_TICK > 1);
});

test("an expired score window orders only with the switch; its bindings still decide", async () => {
  const { amuxV22ScoreCurrent } = await import("../lib/amux/v22AutoPromotionCore.ts");
  const now = new Date("2026-11-14T00:00:00Z");
  const past = new Date("2026-11-12T00:00:00Z");
  const base = { scoreVersion: "v1", expectedVersion: "v1", taskRevision: 3, currentRevision: 3,
    sourceApprovalId: "a", currentSourceApprovalId: "a", activeStaleAt: past, baselineStaleAt: past, now };
  assert.equal(amuxV22ScoreCurrent(base), false, "off: an expired window takes the Task out");
  assert.equal(amuxV22ScoreCurrent({ ...base, orderOnly: true }), true);
  assert.equal(amuxV22ScoreCurrent({ ...base, orderOnly: true, currentRevision: 4 }), false,
    "a revision change still invalidates the score");
  assert.equal(amuxV22ScoreCurrent({ ...base, orderOnly: true, currentSourceApprovalId: "b" }), false);
  assert.equal(amuxV22ScoreCurrent({ ...base, orderOnly: true, expectedVersion: "v2" }), false);
});

test("a card's own route or approval reason is skipped, never a stop for the tick", () => {
  const source = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  const block = source.match(/const SKIPPED_CODES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  for (const code of ["cost_reconfirmation_required", "lane_unbound", "recovery_approval_changed",
    "role_unavailable", "usage_unverified", "attempt_budget_exhausted"]) {
    assert.ok(block.includes(`"${code}"`), code);
  }
  for (const code of ["incident_blocked", "orchestrator_halted", "worker_catalog_unavailable",
    "outcome_unknown"]) {
    assert.ok(!block.includes(`"${code}"`), `${code} still holds every candidate alike`);
  }
});

test("the tick promotes several then claims, and an unknown promotion still stops it", () => {
  const source = readFileSync("app/api/internal/amux/auto-promotion/tick/route.ts", "utf8");
  const flow = source.indexOf("amuxV22PromotionFlowEnabled() && v22Enabled");
  const claim = source.indexOf("const result = await tickV22WorkerClaim();");
  assert.ok(flow > 0 && claim > flow, "promotion runs before the claim");
  const loop = source.slice(flow, claim);
  assert.match(loop, /AMUX_V22_PROMOTIONS_PER_TICK/);
  assert.match(loop, /promoted\.reason === "outcome_unknown"/);
});

test("the candidate query keeps the score window unless the flow is on", () => {
  const source = readFileSync("lib/amux/v22AutoPromotionService.ts", "utf8");
  assert.match(source, /AND \(\$\{amuxV22PromotionFlowEnabled\(\)\} OR\s+\(n\."activeStaleAt" > \$\{now\} AND n\."baselineStaleAt" > \$\{now\}\)\)/);
  assert.match(source, /if \(!amuxV22PromotionFlowEnabled\(\) && !amuxV22AssessmentIdsCurrent\(/);
});
