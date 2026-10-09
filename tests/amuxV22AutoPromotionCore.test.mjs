import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AMUX_V22_AUTO_PROMOTION_CODE_LATCH,
  amuxV22AssessmentIdsCurrent,
  amuxV22AutoPromotionEnabled,
  amuxV22Capacity,
  amuxV22ScoreCurrent,
} from "../lib/amux/v22AutoPromotionCore.ts";

test("v22 stays dark even when its environment flag is set", () => {
  assert.equal(AMUX_V22_AUTO_PROMOTION_CODE_LATCH, false);
  for (const flag of [undefined, "", "enabled", "true"]) {
    assert.equal(amuxV22AutoPromotionEnabled(flag), false);
  }
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

test("a score must bind exact version, revision, approval and both freshness clocks", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const input = { scoreVersion: "v1", expectedVersion: "v1",
    taskRevision: 4, currentRevision: 4, sourceApprovalId: "approval",
    currentSourceApprovalId: "approval",
    activeStaleAt: new Date(now.getTime() + 1),
    baselineStaleAt: new Date(now.getTime() + 1), now };
  assert.equal(amuxV22ScoreCurrent(input), true);
  for (const changed of [
    { scoreVersion: "old" }, { currentRevision: 5 },
    { currentSourceApprovalId: "other" }, { activeStaleAt: now },
    { baselineStaleAt: now },
  ]) {
    assert.equal(amuxV22ScoreCurrent({ ...input, ...changed }), false);
  }
});

test("a newer assessment at any hierarchy level invalidates a promotion score", () => {
  for (const ids of [
    ["initiative", "epic", "feature", "task"],
    ["initiative", "epic", "feature", "story", "task"],
  ]) {
    assert.equal(amuxV22AssessmentIdsCurrent(ids, ids), true);
    for (const index of ids.keys()) {
      const changed = [...ids]; changed[index] = "newer";
      assert.equal(amuxV22AssessmentIdsCurrent(ids, changed), false);
    }
    assert.equal(amuxV22AssessmentIdsCurrent(ids, ids.slice(1)), false);
    assert.equal(amuxV22AssessmentIdsCurrent(ids, [...ids, "extra"]), false);
    assert.equal(amuxV22AssessmentIdsCurrent(ids, [null, ...ids.slice(1)]), false);
  }
});

test("promotion reads the latest assessments only after the audit and task locks", () => {
  const service = readFileSync("lib/amux/v22AutoPromotionService.ts", "utf8");
  const body = service.slice(service.indexOf("async function commitCandidate"),
    service.indexOf("async function readBackLostPromotion"));
  const auditLock = body.indexOf("await takeAuditChainLock(tx)");
  const taskLock = body.indexOf('FOR UPDATE`');
  const latestRead = body.indexOf("const latestAssessments = await Promise.all");
  const freshnessGuard = body.indexOf("if (!amuxV22AssessmentIdsCurrent(");
  assert.ok(auditLock > 0 && taskLock > auditLock &&
    latestRead > taskLock && freshnessGuard > latestRead);
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
