import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import { schemaValidAmuxRoutingCandidate } from "../amuxClaimFixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

class TestApiSecurityError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type AuditCall = {
  reason: string;
  context?: Record<string, unknown>;
};

type World = {
  authorized: boolean;
  executionApiEnabled: boolean;
  auditCalls: AuditCall[];
  auditError: Error | null;
  snapshot: Record<string, unknown>;
  snapshotError: Error | null;
  schedulerFacts: Record<string, unknown> | null;
  authoritativeRouting: Record<string, unknown>;
  claimResult:
    | { claimed: true; revision: number; decisionId: string }
    | {
        claimed: false;
        reason: "cas_lost" | "incident_admission_blocked" | "wip_limit_reached";
      };
  claimError: Error | null;
  claimCalls: number;
};

const candidate = schemaValidAmuxRoutingCandidate("worker-a");
const routing = {
  preferred_worker: "worker-a",
  selected_worker: "worker-a",
  preferred_score: 0.75,
  selected_score: 0.7,
  candidates: [candidate],
};

const validBody = () => ({
  task_id: "TASK-1",
  worker: "worker-a",
  expected_revision: 3,
  decision: {
    scheduler_score: 32,
    scoring_version: "amux-global-priority-v1",
    signals: {
      scheduler: {
        pin: 0,
        age_hours: 0,
        type_weight: 12,
        priority_weight: 20,
        dependents: 0,
        dependent_weight: 0,
        drag: 0,
      },
      routing: {
        scoring_version: "amux-worker-router-v1",
        ...routing,
      },
    },
  },
});

const freshWorld = (): World => ({
  authorized: true,
  executionApiEnabled: true,
  auditCalls: [],
  auditError: null,
  snapshot: {
    eligible: true,
    execution_ready: true,
    reason: null,
    task: {
      task_kind: "feature",
      complexity: 5,
      risk: 1,
      files_expected: 1,
    },
    candidates: [
      {
        worker: {
          worker_name: "worker-a",
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
        predicted_success: null,
        quota_remaining: null,
        expected_speed: null,
        low_rework: null,
        low_human_attention: null,
        cost_efficiency: null,
        provider_exhausted: false,
      },
    ],
    telemetry: {},
  },
  snapshotError: null,
  schedulerFacts: {
    facts: {
      pinned: false,
      createdAt: new Date(),
      kind: "code",
      priority: "p1",
      dependentCount: 0,
      drag: 0,
    },
    capacityWeight: 0,
  },
  authoritativeRouting: routing,
  claimResult: {
    claimed: true,
    revision: 4,
    decisionId: "decision-1",
  },
  claimError: null,
  claimCalls: 0,
});

let world = freshWorld();
let installed = false;

async function loadRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
}> {
  if (!installed) {
    installed = true;

    mock.module(mod("lib/amux/guard.ts"), {
      namedExports: {
        isAmuxSyncAuthorized: () => world.authorized,
      },
    });
    mock.module(mod("lib/amux/executionGate.ts"), {
      namedExports: {
        isAmuxExecutionApiEnabled: () => world.executionApiEnabled,
      },
    });
    mock.module(mod("lib/amux/claimDeadline.ts"), {
      namedExports: {
        AMUX_CLAIM_ROUTE_BUDGET_MS: 12_000,
        anchorAmuxClaimDeadline: async () => {},
      },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ApiSecurityError: TestApiSecurityError,
        readLimitedJson: async (
          request: Request,
          _maxBytes: number,
          schema: { safeParse: (value: unknown) => unknown },
        ) => {
          let input: unknown;
          try {
            input = JSON.parse(await request.text());
          } catch {
            throw new TestApiSecurityError(
              400,
              "INVALID_JSON",
              "parser detail must not escape",
            );
          }

          const parsed = schema.safeParse(input) as
            { success: true; data: unknown } | { success: false };
          if (!parsed.success) {
            throw new TestApiSecurityError(
              400,
              "INVALID_REQUEST",
              "schema detail must not escape",
            );
          }
          return parsed.data;
        },
      },
    });
    mock.module(mod("lib/amux/routing.ts"), {
      namedExports: {
        buildAmuxRoutingSnapshot: async () => {
          if (world.snapshotError) throw world.snapshotError;
          return world.snapshot;
        },
      },
    });
    mock.module(mod("lib/amux/workerRouterCore.ts"), {
      namedExports: {
        scoreAmuxWorkers: () => world.authoritativeRouting,
      },
    });
    mock.module(mod("lib/amux/store.ts"), {
      namedExports: {
        getAuthoritativeSchedulerFacts: async () => world.schedulerFacts,
        recordAmuxClaimRefusal: async (
          reason: string,
          context?: Record<string, unknown>,
        ) => {
          if (world.auditError) throw world.auditError;
          world.auditCalls.push({ reason, context });
        },
        claimUnownedTodo: async () => {
          world.claimCalls += 1;
          if (world.claimError) throw world.claimError;
          return world.claimResult;
        },
      },
    });
  }

  return import(mod("app/api/internal/amux/claim/route.ts"));
}

const request = (body: string | object) =>
  new Request("https://tomverse.app/api/internal/amux/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const assertNoStore = (response: Response) =>
  assert.equal(response.headers.get("cache-control"), "no-store");

test("unauthenticated claim requests never create an audit opportunity", async () => {
  world = freshWorld();
  world.authorized = false;
  const { POST } = await loadRoute();
  const originalError = console.error;
  const operationalLogs: unknown[] = [];
  console.error = (...args: unknown[]) => {
    operationalLogs.push(args);
  };
  let response: Response;
  try {
    response = await POST(request("not-json"));
  } finally {
    console.error = originalError;
  }

  assert.equal(response.status, 401);
  assertNoStore(response);
  assert.deepEqual(world.auditCalls, []);
  assert.deepEqual(operationalLogs, []);
});

test("an ambiguous commit response is an outcome-unknown 503 without blind retry", async () => {
  const { POST } = await loadRoute();
  world = freshWorld();
  world.claimError = Object.assign(
    new Error("private commit transport detail"),
    {
      code: "P2028",
    },
  );
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let response: Response;
  try {
    response = await POST(request(validBody()));
  } finally {
    console.error = originalError;
  }
  assert.equal(response.status, 503);
  assertNoStore(response);
  const body = await response.json();
  assert.match(body.incident_id, /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers.get("x-amux-incident-id"), body.incident_id);
  assert.deepEqual(body, {
    error: "AMUX database outcome is unknown.",
    reason: "amux_outcome_unknown",
    incident_id: body.incident_id,
  });
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).incident_id, body.incident_id);
  assert.equal(logs[0].includes("private commit transport detail"), false);
  assert.equal(world.claimCalls, 1);
});

test("authenticated body and scheduler input refusals are generic 400s and audited", async () => {
  const { POST } = await loadRoute();
  const cases = [
    {
      body: "not-json",
      reason: "invalid_request",
      hasContext: false,
    },
    {
      body: { ...validBody(), unknown: true },
      reason: "invalid_request",
      hasContext: false,
    },
    {
      body: (() => {
        const body = validBody();
        body.decision.signals.scheduler.dependent_weight = 5;
        return body;
      })(),
      reason: "dependent_weight_mismatch",
      hasContext: true,
    },
    {
      body: (() => {
        const body = validBody();
        body.decision.scheduler_score = 33;
        return body;
      })(),
      reason: "scheduler_score_mismatch",
      hasContext: true,
    },
  ];

  for (const scenario of cases) {
    world = freshWorld();
    const response = await POST(request(scenario.body));
    const body = await response.json();

    assert.equal(response.status, 400, scenario.reason);
    assertNoStore(response);
    assert.deepEqual(body, { error: "Invalid request." });
    assert.equal(JSON.stringify(body).includes("detail"), false);
    assert.deepEqual(
      world.auditCalls.map((entry) => entry.reason),
      [scenario.reason],
    );
    assert.equal(
      world.auditCalls[0]?.context !== undefined,
      scenario.hasContext,
    );
  }
});

test("closed claim refusals are structured conflicts with one audit", async () => {
  const { POST } = await loadRoute();

  world = freshWorld();
  world.schedulerFacts = null;
  let response = await POST(request(validBody()));
  assert.equal(response.status, 409);
  assertNoStore(response);
  assert.deepEqual(await response.json(), {
    claimed: false,
    reason: "not_eligible",
  });
  assert.deepEqual(
    world.auditCalls.map((entry) => entry.reason),
    ["not_eligible"],
  );

  world = freshWorld();
  world.snapshot = {
    eligible: false,
    execution_ready: false,
    reason: "not_eligible",
    task: null,
    candidates: [],
  };
  response = await POST(request(validBody()));
  assert.equal(response.status, 409);
  assertNoStore(response);
  assert.deepEqual(await response.json(), {
    claimed: false,
    reason: "not_eligible",
  });
  assert.deepEqual(
    world.auditCalls.map((entry) => entry.reason),
    ["not_eligible"],
  );

  world = freshWorld();
  const invalidEvidence = validBody();
  invalidEvidence.decision.signals.routing.selected_score = 0.6;
  response = await POST(request(invalidEvidence));
  assert.equal(response.status, 409);
  assertNoStore(response);
  assert.deepEqual(await response.json(), {
    claimed: false,
    reason: "invalid_routing_evidence",
  });
  assert.deepEqual(
    world.auditCalls.map((entry) => entry.reason),
    ["invalid_routing_evidence"],
  );

  world = freshWorld();
  const selected = (
    world.snapshot.candidates as Array<{
      worker: { dispatch_ready: boolean };
    }>
  )[0];
  assert.ok(selected);
  selected.worker.dispatch_ready = false;
  response = await POST(request(validBody()));
  assert.equal(response.status, 409);
  assertNoStore(response);
  assert.deepEqual(await response.json(), {
    claimed: false,
    reason: "no_authoritative_worker",
  });
  assert.deepEqual(
    world.auditCalls.map((entry) => entry.reason),
    ["no_authoritative_worker"],
  );

  for (const reason of [
    "incident_admission_blocked",
    "wip_limit_reached",
  ] as const) {
    world = freshWorld();
    world.claimResult = { claimed: false, reason };
    response = await POST(request(validBody()));
    assert.equal(response.status, 409);
    assertNoStore(response);
    assert.deepEqual(await response.json(), { claimed: false, reason });
    // These refusals are written atomically inside claimUnownedTodo.
    assert.deepEqual(world.auditCalls, []);
  }

  world = freshWorld();
  world.claimResult = { claimed: false, reason: "cas_lost" };
  response = await POST(request(validBody()));
  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.deepEqual(await response.json(), { claimed: false });
  assert.deepEqual(world.auditCalls, []);
});

test("audit, database, and claim writer failures are generic no-store 500s", async () => {
  const { POST } = await loadRoute();
  const failures = [
    () => {
      world.executionApiEnabled = false;
      world.auditError = new Error("audit chain internals");
      return request(validBody());
    },
    () => {
      world.snapshotError = new Error("database internals");
      return request(validBody());
    },
    () => {
      world.claimError = new Error("claim writer internals");
      return request(validBody());
    },
  ];

  for (const setup of failures) {
    world = freshWorld();
    const originalError = console.error;
    const operationalLogs: string[] = [];
    console.error = (...args: unknown[]) => {
      operationalLogs.push(args.map(String).join(" "));
    };
    let response: Response;
    try {
      response = await POST(setup());
    } finally {
      console.error = originalError;
    }
    const body = await response.json();

    assert.equal(response.status, 500);
    assertNoStore(response);
    assert.equal(body.error, "Internal server error.");
    assert.match(body.incident_id, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get("X-AMUX-Incident-ID"), body.incident_id);
    assert.equal(JSON.stringify(body).includes("internals"), false);
    assert.equal(operationalLogs.length, 1);
    const log = JSON.parse(operationalLogs[0]);
    assert.equal(log.incident_id, body.incident_id);
    assert.equal(log.error_class, "Error");
    assert.equal(log.error_code, "AMUX_INTERNAL_OPERATION_FAILED");
    assert.equal(operationalLogs[0].includes("internals"), false);
  }
});
