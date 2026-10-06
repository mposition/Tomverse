import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxV22ClaimCapacity, amuxV22RequiredTool, amuxV22WorkerClaimEnabled,
  chooseAmuxV22WorkerRoute } from
  "../lib/amux/v22WorkerClaimCore.ts";
import { v22PromotionTickWire, v22WorkerClaimTickWire } from
  "../lib/amux/v22TickWire.ts";

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

test("v22 tick wire never disguises a receipt as a v8 grant", () => {
  assert.deepEqual(v22PromotionTickWire({ promoted: true, taskId: "task-1",
    receiptId: "receipt-1" }), { promoted: true, policy_version: 22,
    task_id: "task-1", receipt_id: "receipt-1" });
  assert.deepEqual(v22WorkerClaimTickWire({ claimed: true, taskId: "task-1",
    assignmentId: "assignment-1", workerName: "worker-1" }),
  { promoted: false, claimed: true, policy_version: 22,
    task_id: "task-1", assignment_id: "assignment-1",
    worker_name: "worker-1" });
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
