import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_GLOBAL_ACTIVE_LIMIT, amuxV22ClaimCapacity, amuxV22ExecutionRole, amuxV22RequiredTool,
  amuxV22ResumeRoutes, amuxV22WorkerClaimEnabled, amuxV22OneShotRoleSupported, amuxV22OneShotRouteSupported,
  amuxV22TaskRoleSupported, amuxV22TaskWritesPatch, chooseAmuxV22WorkerRoute } from
  "../lib/amux/v22WorkerClaimCore.ts";
import { v22PromotionTickWire, v22WorkerClaimTickWire } from
  "../lib/amux/v22TickWire.ts";
import { autoTickHttpStatus } from "../lib/amux/autoPromotionCore.ts";
import { parseAmuxV22OneShotRequest } from
  "../lib/amux/v22OneShotSidecar.mjs";

test("v22 claim requires its own exact environment switch", () => {
  assert.equal(amuxV22WorkerClaimEnabled("enabled"), true);
  for (const flag of [undefined, "", "disabled", "true", "1", " enabled", "ENABLED"]) {
    assert.equal(amuxV22WorkerClaimEnabled(flag), false);
  }
});

test("Tasks run in parallel up to the global limit and never past the verified workers", () => {
  assert.equal(AMUX_V22_GLOBAL_ACTIVE_LIMIT, 6);
  // A second, third ... normal Task no longer waits for the first.
  for (let assigned = 0; assigned < 6; assigned += 1) {
    assert.equal(amuxV22ClaimCapacity({ verifiedWorkerCount: 9,
      totalAssigned: assigned }).allowed, true, `assigned ${assigned}`);
  }
  assert.equal(amuxV22ClaimCapacity({ verifiedWorkerCount: 9,
    totalAssigned: 6 }).reason, "global_capacity_full");
  // Fewer verified workers than the limit: one Task per worker.
  assert.equal(amuxV22ClaimCapacity({ verifiedWorkerCount: 2,
    totalAssigned: 1 }).allowed, true);
  assert.equal(amuxV22ClaimCapacity({ verifiedWorkerCount: 2,
    totalAssigned: 2 }).reason, "global_capacity_full");
  assert.equal(amuxV22ClaimCapacity({ verifiedWorkerCount: 0,
    totalAssigned: 0 }).reason, "capacity_unconfigured");
  assert.equal(amuxV22ClaimCapacity({ verifiedWorkerCount: 3,
    totalAssigned: -1 }).reason, "capacity_unconfigured");
});

test("the provider running the fewest Tasks wins before price", () => {
  const route = (workerName, provider, perAttemptMicroUsd) => ({
    routeId: workerName, workerName, provider, modelId: "model",
    routePolicyDigest: "a".repeat(64), perAttemptMicroUsd,
  });
  const routes = [route("codex-chore", "openai", "100"),
    route("copilot-impl", "github-copilot", "400"),
    route("claude-impl", "anthropic", "900")];
  const choose = (active, last = {}) => chooseAmuxV22WorkerRoute({ routes,
    priorAuthorWorkers: [], priorAuthorProviders: [], isReview: false,
    activeByProvider: new Map(Object.entries(active)),
    lastAssignedAtByWorker: new Map(Object.entries(last)) })?.workerName;
  // Codex busy: the next Task goes to another provider.
  assert.equal(choose({ openai: 1 }, { "claude-impl": 5 }), "copilot-impl");
  assert.equal(choose({ openai: 1, "github-copilot": 1 }), "claude-impl");
  // A review still avoids its author's provider before anything else.
  assert.equal(chooseAmuxV22WorkerRoute({ routes, priorAuthorWorkers: ["codex-chore"],
    priorAuthorProviders: ["openai"], isReview: true,
    activeByProvider: new Map([["anthropic", 2]]) })?.workerName, "copilot-impl");
});

test("no price competition: at equal load the provider that waited longest takes the Task", () => {
  // Owner decision 2026-11-13: the cheapest list price sent nearly every Task
  // to OpenAI. Price no longer chooses between subscription workers.
  const route = (workerName, provider, perAttemptMicroUsd) => ({
    routeId: workerName, workerName, provider, modelId: "model",
    routePolicyDigest: "a".repeat(64), perAttemptMicroUsd,
  });
  const routes = [route("codex-chore", "openai", "100"), route("codex-chore-2", "openai", "100"),
    route("claude-impl", "anthropic", "900"), route("copilot-chore", "github-copilot", "400")];
  const choose = (last) => chooseAmuxV22WorkerRoute({ routes, priorAuthorWorkers: [],
    priorAuthorProviders: [], isReview: false,
    lastAssignedAtByWorker: new Map(Object.entries(last)) })?.workerName;
  // OpenAI just took one: the dearer Anthropic, which waited longest, is next.
  assert.equal(choose({ "codex-chore": 300, "copilot-chore": 200, "claude-impl": 100 }), "claude-impl");
  // Then Copilot, then OpenAI again.
  assert.equal(choose({ "codex-chore": 300, "copilot-chore": 200, "claude-impl": 400 }), "copilot-chore");
  // Within a provider, its worker that waited longest.
  assert.equal(choose({ "codex-chore": 300, "codex-chore-2": 50, "copilot-chore": 500, "claude-impl": 400 }),
    "codex-chore-2");
  // A worker never assigned goes first.
  assert.equal(choose({ "codex-chore": 300, "copilot-chore": 200 }), "claude-impl");
  // A paid API run still takes the cheapest route.
  assert.equal(chooseAmuxV22WorkerRoute({ routes, priorAuthorWorkers: [], priorAuthorProviders: [],
    isReview: false, preferLowerPrice: true,
    lastAssignedAtByWorker: new Map([["codex-chore", 900]]) })?.workerName, "codex-chore-2");
  // The claim reads each candidate's last assignment and passes it on.
  const claim = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  assert.match(claim, /tx\.amuxV22WorkerAssignment\.groupBy\(\{\s*by: \["workerName"\]/);
  assert.match(claim, /activeByProvider, lastAssignedAtByWorker \}\)/);
  const recovery = readFileSync("lib/amux/v22TaskRecoveryService.ts", "utf8");
  assert.match(recovery, /isReview: false, preferLowerPrice: true \}\)/);
});

test("one tick assigns every ready Task, logs what it passed over, and stops at an unknown outcome", () => {
  const claim = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  const tick = claim.slice(claim.indexOf("export async function tickV22WorkerClaim"));
  // No early return on the first assignment.
  assert.doesNotMatch(tick, /return await claimCandidate/);
  assert.match(tick, /claims\.push\(claimed\)/);
  assert.match(tick, /event: "amux_v22_claim_tick"/);
  assert.match(tick, /stop = "outcome_unknown";\s+break;/);
  assert.match(claim, /isReview: card\.taskRole === "review", activeByProvider, lastAssignedAtByWorker \}\)/);
  assert.doesNotMatch(claim, /laneAssigned|lane_capacity_full|reserved_capacity_unavailable/);
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

test("test and verify Tasks run as implement and investigate; operate is a person's step", () => {
  assert.equal(amuxV22ExecutionRole("test"), "implement");
  assert.equal(amuxV22ExecutionRole("verify"), "investigate");
  for (const role of ["design", "implement", "investigate", "review", "operate"]) {
    assert.equal(amuxV22ExecutionRole(role), role);
  }
  for (const role of ["design", "implement", "test", "verify", "investigate", "review"]) {
    assert.equal(amuxV22TaskRoleSupported(role), true, role);
  }
  for (const role of ["operate", "unknown", "constructor", "__proto__"]) {
    assert.equal(amuxV22TaskRoleSupported(role), false, role);
  }
  // A worker profile and the sidecar still name only the four execution roles.
  for (const role of ["test", "verify"]) assert.equal(amuxV22OneShotRoleSupported(role), false);
  assert.deepEqual(["implement", "test", "verify", "design", "operate", null, undefined]
    .map(amuxV22TaskWritesPatch), [true, true, false, false, false, false, false]);
});

test("claim only selects routes the environment-gated one-shot sidecar can execute", () => {
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
  // Owner decision 2026-10-26: every registered provider class runs v22.
  assert.equal(amuxV22OneShotRouteSupported("openai", "gpt-6-astra"), true);
  assert.equal(amuxV22OneShotRouteSupported("github-copilot", "claude-sonnet-5-5"), true);
  assert.equal(amuxV22OneShotRouteSupported("cursor", "composer-2.5"), true);
  assert.equal(amuxV22OneShotRouteSupported("anthropic", "gpt-6-astra"),
    false);
  assert.equal(amuxV22OneShotRouteSupported("gemini", "gemini-3"), false);
  assert.equal(amuxV22OneShotRouteSupported("openai", "-leading-dash"), false);
  // The sidecar checks the model against its own provider.
  assert.doesNotThrow(() => parseAmuxV22OneShotRequest(
    { ...base, role: "implement", modelId: "gpt-6-luna" }, "worker-a", "openai"));
  assert.throws(() => parseAmuxV22OneShotRequest(
    { ...base, role: "implement", modelId: "gpt-6-luna" }, "worker-a"));
  const claim = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  assert.match(claim, /amuxV22TaskRoleSupported\(card\.taskRole\)/);
  assert.match(claim, /worker\.routing_roles\.includes\(executionRole\)/);
  assert.match(claim, /amuxV22OneShotRouteSupported\(route\.provider, route\.modelId\)/);
  assert.match(claim, /const SKIPPED_CODES = new Set\(\[[^\]]*"one_shot_role_unavailable"/);
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
  // A Task resumed after an owner question narrows the quota routes (those
  // whose worker has settled usage) through amuxV22ResumeRoutes, which only
  // holds the Task for a worker that still serves the Task's grade.
  assert.match(claim, /amuxV22ResumeRoutes\(\{\s+resumeWorker: resume\?\.worker \?\? null,\s+approvedRoutes: approved\.receipt\.routes, routes: settled\.routes,/);
  assert.match(claim, /amuxWorkerMatchesExecutionGrade\(card\.executionGrade, workerName,/);
  assert.match(claim, /chooseAmuxV22WorkerRoute\(\{ routes: resumeRoutes,/);
});

test("a resumed Task waits for the asking worker only while it serves the Task's grade", () => {
  const route = (workerName) => ({ routeId: `route-${workerName}`, workerName });
  const approvedRoutes = [route("codex-chore"), route("claude-contract")];
  const routes = [route("claude-contract")];
  const grades = new Map([["codex-chore", "chore"],
    ["claude-contract", "contract"]]);
  const serves = (grade) => (workerName) => grades.get(workerName) === grade;
  // Same grade: the Task waits for the worker that asked, even while that
  // worker is busy and has no claimable route.
  assert.deepEqual(amuxV22ResumeRoutes({ resumeWorker: "codex-chore",
    approvedRoutes, routes, workerServesGrade: serves("chore") }), []);
  // After escalation the asking worker no longer serves the Task: every
  // allowed route competes and the kept answer goes to whichever takes it.
  assert.deepEqual(amuxV22ResumeRoutes({ resumeWorker: "codex-chore",
    approvedRoutes, routes, workerServesGrade: serves("contract") }), routes);
  // A worker the approved routes no longer name does not hold the Task.
  assert.deepEqual(amuxV22ResumeRoutes({ resumeWorker: "retired-worker",
    approvedRoutes, routes, workerServesGrade: () => true }), routes);
  assert.deepEqual(amuxV22ResumeRoutes({ resumeWorker: null,
    approvedRoutes, routes, workerServesGrade: () => true }), routes);
  assert.deepEqual(amuxV22ResumeRoutes({ resumeWorker: "claude-contract",
    approvedRoutes, routes, workerServesGrade: serves("contract") }), routes);
});
