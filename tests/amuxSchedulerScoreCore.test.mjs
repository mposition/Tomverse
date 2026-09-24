import assert from "node:assert/strict";
import test from "node:test";

import { scoreAmuxScheduler } from "../lib/amux/schedulerScoreCore.ts";

test("server scheduler scorer preserves v1 arithmetic without advanced evidence", () => {
  const score = scoreAmuxScheduler({
    facts: {
      pinned: false,
      createdAt: new Date("2026-09-21T10:00:00Z"),
      kind: "code",
      priority: "p1",
      dependentCount: 2,
      drag: 3,
    },
    now: new Date("2026-09-21T12:00:00Z"),
  });
  assert.equal(score.total, 47);
  assert.deepEqual(
    {
      pin: score.pin,
      age_hours: score.age_hours,
      type_weight: score.type_weight,
      priority_weight: score.priority_weight,
      dependents: score.dependents,
      dependent_weight: score.dependent_weight,
      drag: score.drag,
    },
    {
      pin: 0,
      age_hours: 2,
      type_weight: 12,
      priority_weight: 20,
      dependents: 2,
      dependent_weight: 10,
      drag: 3,
    },
  );
});

test("advanced urgency remains below the explicit pin override", () => {
  const common = {
    facts: {
      pinned: false,
      createdAt: new Date("2026-09-21T00:00:00Z"),
      kind: "chore",
      priority: "p3",
      dependentCount: 0,
      drag: 0,
    },
    now: new Date("2026-09-21T12:00:00Z"),
    deadline: {
      state: "parsed",
      due_at: "2026-08-01T00:00:00Z",
      source: "classification",
      precision: "instant",
      raw: "2026-08-01T00:00:00Z",
    },
  };
  const overdue = scoreAmuxScheduler(common);
  const pinned = scoreAmuxScheduler({
    ...common,
    facts: { ...common.facts, pinned: true },
  });
  assert.equal(overdue.urgency, 240);
  assert.equal(pinned.total - overdue.total, 10_000);
});
