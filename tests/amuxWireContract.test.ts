import assert from "node:assert/strict";
import test from "node:test";

import {
  amuxOwnedQueueResponseSchema,
  amuxQueueResponseSchema,
  amuxRoutingResponseSchema,
} from "@/lib/amux/wireContract";

const queueRow = {
  id: "TASK-1",
  kind: "code",
  priority: "p1",
  pinned: false,
  drag: 0,
  revision: 1,
  created_at: "2026-09-21T00:00:00.000Z",
  dependent_count: 0,
  scheduler_score: 32,
  scoring_version: "amux-global-priority-v2",
  scheduler_signals: {
    pin: 0,
    age_hours: 0,
    type_weight: 12,
    priority_weight: 20,
    dependents: 0,
    dependent_weight: 0,
    drag: 0,
    urgency: 0,
    capacity_weight: 0,
    incident_bonus: 0,
    total: 32,
  },
};

test("selection wire never accepts title, partial capacity, or oversized revisions", () => {
  assert.equal(amuxQueueResponseSchema.safeParse([queueRow]).success, true);
  assert.equal(
    amuxQueueResponseSchema.safeParse([{ ...queueRow, title: "private" }])
      .success,
    false,
  );
  assert.equal(
    amuxQueueResponseSchema.safeParse(Array(513).fill(queueRow)).success,
    false,
  );
  assert.equal(
    amuxQueueResponseSchema.safeParse([
      { ...queueRow, revision: 2_147_483_648 },
    ]).success,
    false,
  );
});

test("owned queue exposes only identity and revision", () => {
  const minimal = { id: "TASK-1", owner: "codex-a", revision: 1 };
  assert.equal(amuxOwnedQueueResponseSchema.safeParse([minimal]).success, true);
  assert.equal(
    amuxOwnedQueueResponseSchema.safeParse([
      { ...minimal, description: "private" },
    ]).success,
    false,
  );
  assert.equal(
    amuxOwnedQueueResponseSchema.safeParse(Array(513).fill(minimal)).success,
    false,
  );
});

test("routing rejects nested unknown fields and contradictory refusal body", () => {
  const refusal = {
    eligible: false,
    execution_ready: false,
    reason: "not_eligible",
    task: null,
    candidates: [],
  };
  assert.equal(amuxRoutingResponseSchema.safeParse(refusal).success, true);
  assert.equal(
    amuxRoutingResponseSchema.safeParse({ ...refusal, execution_ready: true })
      .success,
    false,
  );
  assert.equal(
    amuxRoutingResponseSchema.safeParse({ ...refusal, secret: "leak" }).success,
    false,
  );
});
