import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  amuxOwnedQueueResponseSchema,
  amuxQueueResponseSchema,
  amuxRoutingResponseSchema,
  keepCanonicalAmuxQueueRows,
} from "@/lib/amux/wireContract";

// The queue bodies across the compatibility window, shared with the Rust
// client (apps/tomverse-orchestrator/src/tomverse_api.rs and
// main_wire_compat.rs parse the same file). *_server is what this app sends:
// exactly the fields an orchestrator or WSL bridge built from main before the
// develop AMUX port requires. *_main is what main's server sent; *_minimal is
// the shape the app may send once no such binary runs
// (docs/ops/amux/wsl-execution-bridge.md, "Wire compatibility").
const queueWire = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/fixtures/amux-queue-wire-compat-v1.json"),
    "utf8",
  ),
);
const queueRow = queueWire.queue_server;
const ownedRow = queueWire.owned_server;

// Every field main's Rust structs require without a serde default. Removing
// one from the app's response schema halts a bridge built before the port.
const MAIN_RUST_REQUIRED_QUEUE_FIELDS = [
  "id",
  "title",
  "status",
  "kind",
  "priority",
  "pinned",
  "drag",
  "revision",
  "created_at",
  "dependencies",
  "dependent_count",
];
const MAIN_RUST_REQUIRED_OWNED_FIELDS = [
  "id",
  "title",
  "kind",
  "priority",
  "owner",
  "revision",
  "created_at",
];

// Fields main's Rust reads with a serde default or as an Option. The app
// sends the scheduler evidence and none of the rest.
const MAIN_RUST_DEFAULTED_QUEUE_FIELDS_SENT = [
  "scheduler_score",
  "scoring_version",
  "scheduler_signals",
];

const withoutField = (row: Record<string, unknown>, field: string) => {
  const copy = { ...row };
  delete copy[field];
  return copy;
};

test("selection wire keeps main's required fields during the compatibility window", () => {
  assert.equal(amuxQueueResponseSchema.safeParse([queueRow]).success, true);
  assert.deepEqual(
    Object.keys(queueRow).sort(),
    [
      ...MAIN_RUST_REQUIRED_QUEUE_FIELDS,
      ...MAIN_RUST_DEFAULTED_QUEUE_FIELDS_SENT,
    ].sort(),
  );
  // main's own body carried owner, which main's Rust reads as an Option.
  assert.equal(
    amuxQueueResponseSchema.safeParse([queueWire.queue_main]).success,
    false,
  );
  for (const field of MAIN_RUST_REQUIRED_QUEUE_FIELDS) {
    const without = withoutField(queueRow, field);
    assert.equal(
      amuxQueueResponseSchema.safeParse([without]).success,
      false,
      field,
    );
  }
  // The minimal shape is the later target, not what this app sends yet.
  assert.equal(
    amuxQueueResponseSchema.safeParse([queueWire.queue_minimal]).success,
    false,
  );
  assert.equal(
    amuxQueueResponseSchema.safeParse([{ ...queueRow, future_field: true }])
      .success,
    false,
  );
  assert.equal(
    amuxQueueResponseSchema.safeParse([{ ...queueRow, owner: "claimed" }])
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

test("owned queue keeps main's required fields during the compatibility window", () => {
  assert.equal(amuxOwnedQueueResponseSchema.safeParse([ownedRow]).success, true);
  assert.deepEqual(
    Object.keys(ownedRow).sort(),
    [...MAIN_RUST_REQUIRED_OWNED_FIELDS].sort(),
  );
  // description and claimed_at are Options in main's Rust and are not sent:
  // free text of up to 50,000 characters has no place under a 512 KB ceiling.
  assert.equal(
    amuxOwnedQueueResponseSchema.safeParse([queueWire.owned_main]).success,
    false,
  );
  for (const field of MAIN_RUST_REQUIRED_OWNED_FIELDS) {
    const without = withoutField(ownedRow, field);
    assert.equal(
      amuxOwnedQueueResponseSchema.safeParse([without]).success,
      false,
      field,
    );
  }
  assert.equal(
    amuxOwnedQueueResponseSchema.safeParse([queueWire.owned_minimal]).success,
    false,
  );
  assert.equal(
    amuxOwnedQueueResponseSchema.safeParse([{ ...ownedRow, future_field: 1 }])
      .success,
    false,
  );
  assert.equal(
    amuxOwnedQueueResponseSchema.safeParse(Array(513).fill(ownedRow)).success,
    false,
  );
});

test("a row with a non-canonical stored id is dropped and counted, not a failed queue", (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => warnings.push(line));

  const rows = [
    queueRow,
    { ...queueRow, id: "TASK-trailing-" },
    { ...queueRow, id: "TASK with space" },
  ];
  const kept = keepCanonicalAmuxQueueRows("selection", rows, (row) => [row.id]);
  assert.deepEqual(kept, [queueRow]);
  assert.equal(amuxQueueResponseSchema.safeParse(kept).success, true);
  // The unfiltered body is what used to reach the schema and fail it.
  assert.equal(amuxQueueResponseSchema.safeParse(rows).success, false);
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0]), {
    subsystem: "amux",
    event: "queue_rows_rejected",
    queue: "selection",
    reason: "non_canonical_machine_id",
    rejected_rows: 2,
    kept_rows: 1,
  });
  assert.doesNotMatch(warnings[0], /TASK-trailing-|TASK with space/);

  const owned = keepCanonicalAmuxQueueRows(
    "owned",
    [ownedRow, { ...ownedRow, owner: "worker-" }],
    (row) => [row.id, row.owner],
  );
  assert.deepEqual(owned, [ownedRow]);
  assert.equal(JSON.parse(warnings[1]).queue, "owned");
  assert.equal(JSON.parse(warnings[1]).rejected_rows, 1);

  // A clean queue logs nothing.
  keepCanonicalAmuxQueueRows("selection", [queueRow], (row) => [row.id]);
  assert.equal(warnings.length, 2);
});

test("the Rust client accepts the compatibility queue fields and never requires them", () => {
  const api = readFileSync(
    join(process.cwd(), "apps/tomverse-orchestrator/src/tomverse_api.rs"),
    "utf8",
  );
  const structBody = (name: string) => {
    const start = api.indexOf(
      `#[serde(deny_unknown_fields)]\npub struct ${name} {`,
    );
    assert.notEqual(start, -1, `${name} keeps deny_unknown_fields`);
    return api.slice(start, api.indexOf("\n}", start));
  };
  for (const [struct, fields] of [
    ["QueueTask", ["title", "status", "owner", "dependencies"]],
    [
      "OwnedTodoTask",
      ["title", "description", "kind", "priority", "claimed_at", "created_at"],
    ],
  ] as const) {
    const body = structBody(struct);
    for (const field of fields) {
      assert.ok(
        body.includes(
          `#[serde(default, rename = "${field}")]\n    pub legacy_${field}: Option<`,
        ),
        `${struct}.${field} is accepted with a default`,
      );
    }
  }
  assert.ok(
    api.includes(
      "fn queue_rows_parse_in_the_server_shape_and_the_minimal_shape()",
    ),
  );
  assert.ok(
    api.includes(
      "fn owned_queue_rows_parse_in_the_server_shape_and_the_minimal_shape()",
    ),
  );
  assert.ok(
    api.includes('"../../../tests/fixtures/amux-queue-wire-compat-v1.json"'),
    "the Rust tests parse the same fixture",
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
