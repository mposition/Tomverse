import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAmuxV4TaskReady } from
  "../lib/amux/v4TaskReadyCore.ts";
import { parseAmuxV4TaskReceipt } from
  "../lib/amux/v4TaskReadyService.ts";

const base = () => ({
  card: { sourceSystem: "admin-idea-v4", cardType: "task",
    status: "backlog", archived: false, owner: null, claimed: false,
    role: "implement", grade: "advanced", briefAndScopeVerified: true },
  sourceApprovalValid: true, parentPathCurrent: true,
  approvedDependencyIds: ["design-task"],
  dependencies: [{ id: "design-task", approvedTask: true,
    status: "done", terminal: true }],
  cost: "allow", compatibleWorkerCount: 1, orchestratorHalted: false,
});

test("a complete approved v4 Task is only observed as ready", () => {
  const result = evaluateAmuxV4TaskReady(base());
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.completedDependencyCount, 1);
  assert.equal(result.promotionAuthorized, false);
  assert.equal(result.claimAuthorized, false);
});

test("claim qualification requires unassigned Todo, not a backlog card", () => {
  const todo = { ...base(), card: { ...base().card, status: "todo" } };
  assert.equal(evaluateAmuxV4TaskReady(todo, "todo").ready, true);
  assert.equal(evaluateAmuxV4TaskReady(todo).ready, false);
  assert.equal(evaluateAmuxV4TaskReady(base(), "todo").ready, false);
});

test("a Story and a legacy stage-cycle card cannot become ready", () => {
  for (const card of [{ cardType: "story" },
    { sourceSystem: "board-import", cardType: "task" }]) {
    const result = evaluateAmuxV4TaskReady({ ...base(),
      card: { ...base().card, ...card } });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.includes("not_v4_task"));
  }
});

test("missing approval, path, scope, role, price, worker and halt fail closed", () => {
  const cases = [
    [{ sourceApprovalValid: false }, "source_approval_invalid"],
    [{ parentPathCurrent: false }, "parent_path_changed"],
    [{ card: { ...base().card, briefAndScopeVerified: false } },
      "brief_or_scope_missing"],
    [{ card: { ...base().card, grade: null } }, "role_or_grade_missing"],
    [{ cost: "hold" }, "cost_unavailable"],
    [{ cost: "reconfirm" }, "cost_reconfirmation_required"],
    [{ compatibleWorkerCount: 0 }, "worker_unavailable"],
    [{ orchestratorHalted: true }, "orchestrator_halted"],
  ];
  for (const [change, reason] of cases) {
    const result = evaluateAmuxV4TaskReady({ ...base(), ...change });
    assert.equal(result.ready, false, reason);
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test("only explicit approved completed dependencies count", () => {
  const missing = evaluateAmuxV4TaskReady({ ...base(), dependencies: [] });
  assert.deepEqual(missing.reasons, ["dependency_set_changed"]);
  const extra = evaluateAmuxV4TaskReady({ ...base(), dependencies: [
    ...base().dependencies, { id: "unapproved", approvedTask: false,
      status: "done", terminal: true },
  ] });
  assert.deepEqual(extra.reasons, ["dependency_set_changed"]);
  const unfinished = evaluateAmuxV4TaskReady({ ...base(), dependencies: [
    { id: "design-task", approvedTask: true,
      status: "review", terminal: false },
  ] });
  assert.deepEqual(unfinished.reasons, ["dependency_incomplete"]);
});

test("malformed parent Story or hierarchy content is refused before path access", () => {
  const content = { digest: "a".repeat(64), keyId: "key" };
  const valid = { action: "register_card", card: {
    cardType: "task", normalizedBody: content,
    task: { role: "implement", grade: "advanced", brief: content,
      costReceipt: {} },
    parentStory: { id: "story", revision: 0, content }, dependencies: [],
  }, hierarchy: ["initiative", "epic", "feature"].map((id) => ({
    id, approvedDecisionId: `decision-${id}`, revision: 0, content,
  })) };
  assert.ok(parseAmuxV4TaskReceipt(valid));
  const missingStoryContent = structuredClone(valid);
  delete missingStoryContent.card.parentStory.content;
  assert.equal(parseAmuxV4TaskReceipt(missingStoryContent), null);
  const missingHierarchyContent = structuredClone(valid);
  delete missingHierarchyContent.hierarchy[0].content.digest;
  assert.equal(parseAmuxV4TaskReceipt(missingHierarchyContent), null);
});
