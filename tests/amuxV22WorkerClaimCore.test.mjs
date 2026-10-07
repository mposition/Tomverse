import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxV22ClaimCapacity, amuxV22RequiredTool, amuxV22WorkerClaimEnabled,
  amuxV22OneShotRoleSupported, amuxV22OneShotRouteSupported,
  chooseAmuxV22WorkerRoute } from
  "../lib/amux/v22WorkerClaimCore.ts";
import { v22PromotionTickWire, v22WorkerClaimTickWire } from
  "../lib/amux/v22TickWire.ts";
import { autoTickHttpStatus } from "../lib/amux/autoPromotionCore.ts";
import { parseAmuxV22OneShotRequest } from
  "../lib/amux/v22OneShotSidecar.mjs";

test("v22 claim stays dark even when its environment switch is set", () => {
  assert.equal(amuxV22WorkerClaimEnabled("enabled"), false);
});

test("global three, one per lane and the two reserved slots are separate", () => {
  assert.equal(amuxV22ClaimCapacity({ lane: "normal",
    verifiedWorkerCount: 3, totalAssigned: 0, laneAssigned: 0 }).allowed, true);
  assert.equal(amuxV22ClaimCapacity({ lane: "normal",
    verifiedWorkerCount: 3, totalAssigned: 1, laneAssigned: 1 }).allowed, false);
  assert.equal(amuxV22ClaimCapacity({ lane: "parallel",
    verifiedWorkerCount: 3, totalAssigned: 1, laneAssigned: 0 }).allowed, true);
  assert.equal(amuxV22ClaimCapacity({ lane: "sev1",
    verifiedWorkerCount: 3, totalAssigned: 2, laneAssigned: 0 }).allowed, true);
  assert.equal(amuxV22ClaimCapacity({ lane: "sev1",
    verifiedWorkerCount: 3, totalAssigned: 3, laneAssigned: 0 }).allowed, false);
  assert.equal(amuxV22ClaimCapacity({ lane: "normal",
    verifiedWorkerCount: 2, totalAssigned: 0, laneAssigned: 0 }).reason,
  "reserved_capacity_unavailable");
  assert.equal(amuxV22ClaimCapacity({ lane: "sev1",
    verifiedWorkerCount: 1, totalAssigned: 0, laneAssigned: 0 }).allowed, true);
  assert.equal(amuxV22ClaimCapacity({ lane: "sev1",
    verifiedWorkerCount: 1, totalAssigned: 1, laneAssigned: 0 }).allowed, false);
});

test("review prefers another provider and never selects its author", () => {
  const route = (workerName, provider, perAttemptMicroUsd) => ({
    routeId: workerName, workerName, provider, modelId: "model",
    routePolicyDigest: "a".repeat(64), perAttemptMicroUsd,
  });
  const selected = chooseAmuxV22WorkerRoute({
    routes: [route("author", "openai", "1"),
      route("same-provider", "openai", "2"),
      route("other-provider", "anthropic", "9")],
    priorAuthorWorkers: ["author"], priorAuthorProviders: ["openai"],
    isReview: true,
  });
  assert.equal(selected?.workerName, "other-provider");
  assert.equal(chooseAmuxV22WorkerRoute({
    routes: [route("author", "openai", "1")],
    priorAuthorWorkers: ["author"], priorAuthorProviders: ["openai"],
    isReview: true,
  }), null);
});

test("task role has a closed tool requirement and unknown roles hold", () => {
  assert.equal(amuxV22RequiredTool("implement"), "repo_write");
  assert.equal(amuxV22RequiredTool("review"), "repo_read");
  assert.equal(amuxV22RequiredTool("unknown"), null);
});

test("claim only selects routes the default-off one-shot sidecar can execute", () => {
  const base = { version: 1,
    attemptId: "00000000-0000-4000-8000-000000000001",
    worker: "worker-a", modelId: "claude-opus-5-5",
    budgetMicrousd: 1_000_000, prompt: "Synthetic task" };
  for (const role of ["design", "implement", "review", "investigate"]) {
    assert.equal(amuxV22OneShotRoleSupported(role), true);
    assert.doesNotThrow(() => parseAmuxV22OneShotRequest(
      { ...base, role }, "worker-a"));
  }
  for (const role of ["test", "verify", "operate", "unknown"]) {
    assert.equal(amuxV22OneShotRoleSupported(role), false);
    assert.throws(() => parseAmuxV22OneShotRequest(
      { ...base, role }, "worker-a"));
  }
  assert.equal(amuxV22OneShotRouteSupported("anthropic", "claude-opus-5-5"),
    true);
  assert.equal(amuxV22OneShotRouteSupported("openai", "gpt-6-astra"), false);
  assert.equal(amuxV22OneShotRouteSupported("anthropic", "gpt-6-astra"),
    false);
  const claim = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  assert.match(claim, /amuxV22OneShotRoleSupported\(card\.taskRole\)/);
  assert.match(claim, /amuxV22OneShotRouteSupported\(route\.provider, route\.modelId\)/);
  assert.match(claim, /"one_shot_role_unavailable",[\s\S]*?\]\.includes\(error\.code\)\) continue/);
});

test("v22 tick wire never disguises a receipt as a v8 grant", () => {
  assert.deepEqual(v22PromotionTickWire({ promoted: true, taskId: "task-1",
    receiptId: "receipt-1" }), { promoted: true, policy_version: 22,
    task_id: "task-1", receipt_id: "receipt-1" });
  assert.deepEqual(v22WorkerClaimTickWire({ claimed: true, taskId: "task-1",
    assignmentId: "assignment-1", workerName: "worker-1" }),
  { promoted: false, claimed: true, policy_version: 22,
    task_id: "task-1", assignment_id: "assignment-1",
    worker_name: "worker-1" });
  const route = readFileSync("app/api/internal/amux/auto-promotion/tick/route.ts", "utf8");
  assert.match(route, /Response\.json\(v22PromotionTickWire\(result\)/);
  assert.match(route, /Response\.json\(v22WorkerClaimTickWire\(result\)/);
  assert.match(route, /status: result\.claimed \? 200 : autoTickHttpStatus\(result\.reason\)/);
  assert.match(route, /status: result\.promoted \? 200 : autoTickHttpStatus\(result\.reason\)/);
  assert.match(route, /reason: "apply_disabled", expired: 0/);
  assert.doesNotMatch(route, /orchestrator_identity_required/);
  for (const [reason, status] of [
    ["no_candidate", 200], ["auto_halted", 200],
    ["apply_disabled", 409], ["outcome_unknown", 409],
    ["audit_key_missing", 503], ["audit_unbound", 500],
  ]) {
    assert.equal(autoTickHttpStatus(reason), status, reason);
  }
});

test("assigned v4 Todo stays out of the legacy owned queue and execution start", () => {
  const store = readFileSync("lib/amux/store.ts", "utf8");
  const execution = readFileSync("lib/amux/execution.ts", "utf8");
  const owned = store.slice(store.indexOf("export async function listOwnedTodos"),
    store.indexOf("export async function ",
      store.indexOf("export async function listOwnedTodos") + 1));
  assert.match(owned, /legacyDispatchSourceFilter\(\)/);
  assert.match(execution, /planning\.sourceSystem === "admin-idea-v4"/);
  assert.match(execution, /lockedTask\.sourceSystem === "admin-idea-v4"/);
});

test("review independence traces implementation through intermediate Task edges", () => {
  const claim = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  assert.match(claim, /WITH RECURSIVE ancestors/);
  assert.match(claim, /JOIN ancestors a ON a\."dependencyId" = d\."taskId"/);
  assert.match(claim, /w\."taskRole" = 'implement'/);
  assert.match(claim, /w\."v4TerminalAt" IS NOT NULL/);
  assert.match(claim, /chooseAmuxV22WorkerRoute\(\{ routes: quotaRoutes,/);
});
