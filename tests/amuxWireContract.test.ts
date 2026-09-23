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
    telemetry: {},
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

test("routing accepts complete telemetry evidence and rejects extra metric fields", () => {
  const metric = {
    value: 0.7,
    raw_value: 0.8,
    confidence: 0.66,
    observed: true,
    source: "historical_attempts" as const,
    sample_size: 8,
    observed_at: "2026-09-24T00:00:00.000Z",
  };
  const response = {
    eligible: true,
    execution_ready: true,
    reason: null,
    task: {
      task_kind: "feature",
      complexity: 4,
      risk: 1,
      files_expected: 2,
    },
    candidates: [
      {
        worker: {
          worker_name: "codex-a",
          provider: "codex",
          model: null,
          routing_roles: ["feature"],
          running: true,
          status: "idle",
          dispatch_ready: true,
          archived: false,
          paused: false,
          isolated: false,
          blocked: false,
        },
        predicted_success: 0.7,
        quota_remaining: 0.5,
        expected_speed: 0.6,
        low_rework: 0.7,
        low_human_attention: 0.5,
        cost_efficiency: 0.5,
        provider_exhausted: false,
      },
    ],
    telemetry: {
      "codex-a": {
        history: {
          sample_size: 8,
          predicted_success: metric,
          expected_speed: metric,
          low_rework: metric,
          low_human_attention: metric,
          cost_efficiency: {
            ...metric,
            source: "historical_cost" as const,
          },
        },
        quota: {
          ...metric,
          source: "provider_api" as const,
          state: "fresh" as const,
          provider_exhausted: false,
          reset_at: null,
        },
      },
    },
  };

  assert.equal(amuxRoutingResponseSchema.safeParse(response).success, true);
  assert.equal(
    amuxRoutingResponseSchema.safeParse({
      ...response,
      telemetry: {
        "codex-a": {
          history: { sample_size: 0 },
          quota: { state: "unknown", provider_exhausted: false },
        },
      },
    }).success,
    true,
  );
  assert.equal(
    amuxRoutingResponseSchema.safeParse({
      ...response,
      telemetry: {
        "codex-a": {
          history: { sample_size: 0 },
          quota: {
            state: "unknown",
            provider_exhausted: false,
            secret: "leak",
          },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    amuxRoutingResponseSchema.safeParse({
      ...response,
      telemetry: {
        "codex-a": {
          ...response.telemetry["codex-a"],
          history: {
            ...response.telemetry["codex-a"].history,
            predicted_success: { ...metric, secret: "leak" },
          },
        },
      },
    }).success,
    false,
  );
  for (const telemetry of [
    {
      "codex-a": {
        ...response.telemetry["codex-a"],
        secret: "leak",
      },
    },
    {
      "codex-a": {
        ...response.telemetry["codex-a"],
        history: {
          ...response.telemetry["codex-a"].history,
          secret: "leak",
        },
      },
    },
    {
      "codex-a": {
        ...response.telemetry["codex-a"],
        quota: {
          ...response.telemetry["codex-a"].quota,
          secret: "leak",
        },
      },
    },
  ]) {
    assert.equal(
      amuxRoutingResponseSchema.safeParse({ ...response, telemetry }).success,
      false,
    );
  }
});
