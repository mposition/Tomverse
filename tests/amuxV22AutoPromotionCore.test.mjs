import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  amuxV22Capacity,
  amuxV22ScoreCurrent,
} from "../lib/amux/v22AutoPromotionCore.ts";
import { autoGraduationAccepted } from "../lib/amux/autoPromotionCore.ts";

test("no count of human decisions gates the automatic path", () => {
  assert.deepEqual(autoGraduationAccepted([]), {
    ok: true, count: 0, spanMs: 0,
  });
});

test("activation uses the owner audit writer and keeps the existing safety gates", () => {
  const service = readFileSync("lib/amux/v22AutoPromotionService.ts", "utf8");
  assert.match(service, /writeAdminAuditLog\(\{ tx/);
  assert.match(service, /activationAudit\.actorUserId !== control\.approvedByUserId/);
  for (const guard of ["legacy_auto_promotion_enabled", "auto_halted",
    "incident_blocked", "capacity_unconfigured", "score_changed", "task_not_ready"]) {
    assert.match(service, new RegExp(guard));
  }
});

test("owner control uses canonical failure handling and stays separate from guarded board admission", () => {
  const ui = readFileSync("components/admin/AmuxV22PromotionControl.tsx", "utf8");
  const board = readFileSync("components/admin/AmuxExecutionWorkspace.tsx", "utf8");
  assert.match(ui, /runAmuxAutoAdmissionChange/);
  assert.match(ui, /AdminApiFailureNotice failure=\{failure\}/);
  assert.match(ui, /readAdminApiFailure/);
  assert.doesNotMatch(board, /method: "POST"/);
  assert.doesNotMatch(board, /\/api\/admin\/amux\/v22\/promotion-control/);
  assert.match(board, /AmuxExecutionMovePanel/);
});

test("normal admission respects wip, three-times-worker ceiling and two reserved lanes", () => {
  assert.deepEqual(amuxV22Capacity({ active: true, wipLimit: 12,
    verifiedWorkerCount: 3, occupied: 6 }), {
    allowed: true, reason: null, queueLimit: 9, normalLimit: 7,
  });
  assert.deepEqual(amuxV22Capacity({ active: true, wipLimit: 12,
    verifiedWorkerCount: 3, occupied: 7 }), {
    allowed: false, reason: "capacity_full", queueLimit: 9, normalLimit: 7,
  });
  assert.deepEqual(amuxV22Capacity({ active: true, wipLimit: 4,
    verifiedWorkerCount: 8, occupied: 2 }), {
    allowed: false, reason: "capacity_full", queueLimit: 4, normalLimit: 2,
  });
  for (const input of [
    { active: false, wipLimit: 12, verifiedWorkerCount: 3, occupied: 0 },
    { active: true, wipLimit: null, verifiedWorkerCount: 3, occupied: 0 },
    { active: true, wipLimit: 12, verifiedWorkerCount: 0, occupied: 0 },
    { active: true, wipLimit: 12, verifiedWorkerCount: 3, occupied: -1 },
  ]) {
    assert.equal(amuxV22Capacity(input).reason, "capacity_unconfigured");
  }
});

test("a score must bind exact version, revision and approval", () => {
  const input = { scoreVersion: "v1", expectedVersion: "v1",
    taskRevision: 4, currentRevision: 4, sourceApprovalId: "approval",
    currentSourceApprovalId: "approval" };
  assert.equal(amuxV22ScoreCurrent(input), true);
  for (const changed of [
    { scoreVersion: "old" }, { currentRevision: 5 },
    { currentSourceApprovalId: "other" },
  ]) {
    assert.equal(amuxV22ScoreCurrent({ ...input, ...changed }), false);
  }
});

test("the legacy scheduler never claims a v22 Todo", () => {
  const store = readFileSync("lib/amux/store.ts", "utf8");
  const filter = store.slice(store.indexOf("const legacyDispatchSourceFilter"),
    store.indexOf("/**\n * The global scheduler"));
  assert.match(filter, /sourceSystem: null/);
  assert.match(filter, /sourceSystem: \{ not: "admin-idea-v4" \}/);
  for (const name of ["listDispatchable", "getRoutingSnapshotTask",
    "getAuthoritativeSchedulerFacts", "claimUnownedTodo"]) {
    const start = store.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, name);
    const next = store.indexOf("export async function ", start + 1);
    const body = store.slice(start, next < 0 ? undefined : next);
    assert.match(body, /legacyDispatchSourceFilter\(\)/, name);
  }
});

test("v22 admission reuses the legacy queue-lock transaction, not a separate counter", () => {
  const service = readFileSync("lib/amux/v22AutoPromotionService.ts", "utf8");
  const shared = readFileSync("lib/amux/autoPromotionService.ts", "utf8");
  assert.match(service, /return withAutoTransaction\(input\.receiptId, TICK_TRANSACTION_LIMITS/);
  assert.match(shared, /pg_advisory_xact_lock\(hashtext\(\$\{RECOMMENDATION_LOCK_NAME\}\)\)/);
  assert.match(service, /status: \{ in: \["todo", "doing"\] \}/);
  assert.match(service, /capacityOccupied: capacity\.occupied/);
});
