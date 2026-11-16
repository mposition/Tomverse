import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// AMUX process audit bundle 3 (owner decision 2026-11-14, AMUXFLOW/B3):
// promotion folded into the claim. Always on since 2026-11-16.

test("a tick promotes several Tasks per tick", async () => {
  const core = await import("../lib/amux/v22AutoPromotionCore.ts");
  assert.ok(core.AMUX_V22_PROMOTIONS_PER_TICK > 1);
});

test("the score orders only; its bindings still decide", async () => {
  const { amuxV22ScoreCurrent } = await import("../lib/amux/v22AutoPromotionCore.ts");
  const base = { scoreVersion: "v1", expectedVersion: "v1", taskRevision: 3, currentRevision: 3,
    sourceApprovalId: "a", currentSourceApprovalId: "a" };
  assert.equal(amuxV22ScoreCurrent(base), true);
  assert.equal(amuxV22ScoreCurrent({ ...base, currentRevision: 4 }), false,
    "a revision change still invalidates the score");
  assert.equal(amuxV22ScoreCurrent({ ...base, currentSourceApprovalId: "b" }), false);
  assert.equal(amuxV22ScoreCurrent({ ...base, expectedVersion: "v2" }), false);
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

test("the claim stays first; a tick that assigned nothing promotes several, and an unknown promotion still stops it", () => {
  const source = readFileSync("app/api/internal/amux/auto-promotion/tick/route.ts", "utf8");
  const claim = source.indexOf("const result = await tickV22WorkerClaim();");
  const flow = source.indexOf("for (let index = 0; index < AMUX_V22_PROMOTIONS_PER_TICK");
  assert.ok(claim > 0 && flow > claim, "the claim runs before any promotion write");
  const loop = source.slice(flow, flow + 1200);
  assert.match(loop, /promoted.reason === "outcome_unknown"/);
});

test("the candidate query keeps no score window and the promotion checks no newer assessment", () => {
  const source = readFileSync("lib/amux/v22AutoPromotionService.ts", "utf8");
  assert.doesNotMatch(source, /activeStaleAt" > /);
  assert.doesNotMatch(source, /amuxV22AssessmentIdsCurrent/);
});
