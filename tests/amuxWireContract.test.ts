import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// The orchestrator deserializes this body with `deny_unknown_fields`, so a
// top-level key the server adds and Rust lacks fails every routing snapshot of
// a non-empty queue at runtime. `telemetry` did exactly that. The key list is
// therefore pinned three ways: the server schema, the Rust struct, and one
// fixture that both sides parse (apps/tomverse-orchestrator/src/tomverse_api.rs
// reads the same file in its own tests).
const routingFixturePath = "tests/fixtures/amux-routing-snapshot-v1.json";
const routingFixtures = JSON.parse(
  readFileSync(join(process.cwd(), routingFixturePath), "utf8"),
) as Record<"eligible" | "refusal", Record<string, unknown>>;
const rustApiSource = readFileSync(
  join(process.cwd(), "apps", "tomverse-orchestrator", "src", "tomverse_api.rs"),
  "utf8",
);

const rustRoutingSnapshotFields = () => {
  const struct = rustApiSource.match(
    /#\[serde\(deny_unknown_fields\)\]\s*pub struct RoutingSnapshotResponse \{([\s\S]*?)\n\}/,
  );
  assert.ok(
    struct,
    "RoutingSnapshotResponse must keep deny_unknown_fields directly on the struct",
  );
  // A field attribute (rename, default, flatten) would break the one-to-one
  // name mapping this test relies on, or make a contract field optional.
  assert.doesNotMatch(struct[1], /#\[serde\(/);
  return [...struct[1].matchAll(/^\s*pub ([a-z_][a-z0-9_]*):/gm)]
    .map((match) => match[1])
    .sort();
};

test("the routing snapshot has one top-level key list on the server, in Rust and in the shared fixture", () => {
  const rustFields = rustRoutingSnapshotFields();
  assert.ok(rustFields.includes("telemetry"));
  assert.equal(amuxRoutingResponseSchema.options.length, 2);
  for (const branch of amuxRoutingResponseSchema.options) {
    assert.deepEqual(Object.keys(branch.shape).sort(), rustFields);
  }
  for (const name of ["eligible", "refusal"] as const) {
    const parsed = amuxRoutingResponseSchema.safeParse(routingFixtures[name]);
    assert.equal(
      parsed.success,
      true,
      parsed.success ? undefined : `${name}: ${parsed.error.message}`,
    );
    assert.deepEqual(Object.keys(routingFixtures[name]).sort(), rustFields, name);
  }
  assert.equal(routingFixtures.eligible.eligible, true);
  assert.equal(routingFixtures.refusal.eligible, false);
  assert.ok(
    rustApiSource.includes(`"../../../${routingFixturePath}"`),
    "the Rust tests must parse the same fixture",
  );
});
