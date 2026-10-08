// The routes the running Rust client calls, driven with the exact bodies that
// client sends, answering with the exact bodies it parses.
//
// The WSL bridge and the claim-only orchestrator running today were built from
// main 7724fd683 or later, before develop's AMUX came to main. This server
// deploys first and must not break them. tests/fixtures/amux-main-rust-wire-v1.json
// holds each request as that Rust serializes it and each response this app
// returns; apps/tomverse-orchestrator/src/main_wire_compat.rs parses every
// response with a frozen copy of that Rust's structs and with the current
// ones, and serializes every request with both. Only the database-facing
// writers are replaced here: authentication, the execution gate, request
// parsing, the zod schemas and the response mapping are the real route code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const readJson = (relative: string) =>
  JSON.parse(readFileSync(resolve(ROOT, relative), "utf8"));

type Exchange = {
  name: string;
  path: string;
  request: Record<string, unknown>;
  status: number;
  response: unknown;
};

const wire = readJson("tests/fixtures/amux-main-rust-wire-v1.json") as {
  exchanges: Exchange[];
  claim_responses: { status: number; response: Record<string, unknown> }[];
};
const queueWire = readJson("tests/fixtures/amux-queue-wire-compat-v1.json");
const routingWire = readJson("tests/fixtures/amux-routing-snapshot-v1.json");

const LEASE = new Date("2026-09-29T00:01:30.000Z");
const ATTEMPT = "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f";
const RECEIPT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
let v22DeliveryProfile: { modelId: string; role: string;
  budgetMicrousd: number } | null = null;
const calls: { writer: string; input: unknown }[] = [];
const record = (writer: string, input: unknown) => {
  calls.push({ writer, input });
};

class TestBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => true },
});
mock.module(mod("lib/amux/executionGate.ts"), {
  namedExports: { isAmuxExecutionApiEnabled: () => true },
});
mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
    AmuxDbBoundaryError: TestBoundaryError,
    withAmuxRouteBudget: <T>(work: () => Promise<T>) => work(),
  },
});
mock.module(mod("lib/amux/routing.ts"), {
  namedExports: {
    getConfiguredAmuxWorkerCatalog: () => [{ worker_name: "claude-impl" }],
    buildAmuxRoutingSnapshot: async (taskId: string, revision: number) => {
      record("buildAmuxRoutingSnapshot", { taskId, revision });
      return routingWire.eligible;
    },
  },
});
mock.module(mod("lib/amux/workerRuntime.ts"), {
  namedExports: {
    registerAmuxWorkerRuntime: async (workerName: string, instanceId: string) => {
      record("registerAmuxWorkerRuntime", { workerName, instanceId });
      return { generation: 3, leaseExpiresAt: LEASE };
    },
    heartbeatAmuxWorkerRuntime: async (input: { generation: number }) => {
      record("heartbeatAmuxWorkerRuntime", input);
      return input.generation === 3
        ? { accepted: true, leaseExpiresAt: LEASE }
        : { accepted: false, leaseExpiresAt: LEASE, reason: "active_execution" };
    },
  },
});
mock.module(mod("lib/amux/delivery.ts"), {
  namedExports: {
    pullAmuxWorkDelivery: async (input: { generation: number }) => {
      record("pullAmuxWorkDelivery", input);
      if (input.generation !== 3) return { available: false, reason: "none" };
      return {
        available: true,
        delivery: {
          attemptId: ATTEMPT,
          taskId: "TASK-1",
          worker: "claude-impl",
          taskRevision: 3,
          prompt: `Execution attempt: ${ATTEMPT}`,
          v22Execution: v22DeliveryProfile,
          ...(v22DeliveryProfile ? { assignmentId:
            "0a7e13db-0373-4b92-9e74-0b2a79e0e8c7" } : {}),
          receiptId: RECEIPT,
          leaseExpiresAt: LEASE,
        },
      };
    },
    acknowledgeAmuxWorkDelivery: async (input: { taskRevision: number }) => {
      record("acknowledgeAmuxWorkDelivery", input);
      return input.taskRevision === 3
        ? { acknowledged: true, idempotent: false }
        : { acknowledged: false, reason: "fenced_out" };
    },
  },
});
mock.module(mod("lib/amux/execution.ts"), {
  namedExports: {
    startAmuxExecution: async (input: { expectedRevision: number }) => {
      record("startAmuxExecution", input);
      if (input.expectedRevision !== 2) {
        return { started: false, reason: "task_not_startable" };
      }
      return {
        started: true,
        attemptId: ATTEMPT,
        taskRevision: 3,
        leaseExpiresAt: LEASE,
      };
    },
    heartbeatAmuxExecution: async (input: { taskRevision: number }) => {
      record("heartbeatAmuxExecution", input);
      return input.taskRevision === 3;
    },
    settleAmuxExecution: async (input: { taskRevision: number }) => {
      record("settleAmuxExecution", input);
      return input.taskRevision === 3
        ? { settled: true, taskRevision: 4 }
        : { settled: false, reason: "fenced_out" };
    },
  },
});
mock.module(mod("lib/amux/store.ts"), {
  namedExports: {
    // lib/amux/wireContract.ts reads its item bounds from the store module.
    AMUX_QUEUE_MAX_ITEMS: 512,
    AMUX_OWNED_QUEUE_MAX_ITEMS: 512,
    AmuxQueueCapacityError: class extends Error {},
    listDispatchable: async () => [queueWire.queue_server],
    listOwnedTodos: async () => [queueWire.owned_server],
  },
});

const post = async (path: string, body: unknown) => {
  const route = (await import(mod(`app/api/internal/amux/${path}/route.ts`))) as {
    POST: (request: Request) => Promise<Response>;
  };
  return route.POST(
    new Request(`https://tomverse.app/api/internal/amux/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

test("every lifecycle body main's Rust sends is accepted and answered in the shape it parses", async () => {
  for (const exchange of wire.exchanges) {
    const response = await post(exchange.path, exchange.request);
    assert.equal(response.status, exchange.status, exchange.name);
    assert.deepEqual(await response.json(), exchange.response, exchange.name);
  }
});

test("v22 delivery carries its approved one-shot model, role and ceiling", async () => {
  v22DeliveryProfile = { modelId: "claude-opus-5-5", role: "design",
    budgetMicrousd: 1_250_000 };
  try {
    const exchange = wire.exchanges.find((entry) => entry.name === "delivery_pull");
    assert.ok(exchange);
    const response = await post(exchange.path, exchange.request);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.delivery.v22_execution, {
      model_id: "claude-opus-5-5", role: "design",
      budget_microusd: 1_250_000,
    });
    assert.equal(body.delivery.assignment_id,
      "0a7e13db-0373-4b92-9e74-0b2a79e0e8c7");
  } finally { v22DeliveryProfile = null; }
});

test("settle keeps the review PR distinction main's Rust sends: a number, null, or absent", async () => {
  calls.length = 0;
  for (const name of [
    "execution_settle_review_with_pr",
    "execution_settle_review_without_pr",
    "execution_settle_blocked",
  ]) {
    const exchange = wire.exchanges.find((entry) => entry.name === name);
    assert.ok(exchange, name);
    await post(exchange.path, exchange.request);
  }
  const settled = calls
    .filter((call) => call.writer === "settleAmuxExecution")
    .map((call) => (call.input as { reviewPrNumber?: number | null }).reviewPrNumber);
  // Absent keeps the stored PR; null clears it; a number records it.
  assert.deepEqual(settled, [1740, null, undefined]);
});

test("queue, owned queue and routing snapshot bodies match what the Rust clients parse", async () => {
  const queue = await post("queue", {});
  assert.equal(queue.status, 200);
  assert.deepEqual(await queue.json(), [queueWire.queue_server]);

  const owned = await post("owned-queue", {});
  assert.equal(owned.status, 200);
  assert.deepEqual(await owned.json(), [queueWire.owned_server]);

  const routing = await post("routing-snapshot", {
    task_id: "TASK-1",
    expected_revision: 1,
  });
  assert.equal(routing.status, 200);
  assert.deepEqual(await routing.json(), routingWire.eligible);
});

test("the claim responses in the fixture are exactly the ones the claim route can send", async () => {
  const { AMUX_CLAIM_CLOSED_REFUSAL_REASONS } = (await import(
    mod("lib/amux/auditContract.ts")
  )) as { AMUX_CLAIM_CLOSED_REFUSAL_REASONS: readonly string[] };
  const refusals = wire.claim_responses
    .filter((entry) => typeof entry.response.reason === "string")
    .map((entry) => entry.response.reason);
  assert.deepEqual(refusals, [...AMUX_CLAIM_CLOSED_REFUSAL_REASONS]);
  for (const entry of wire.claim_responses) {
    assert.equal(
      entry.status,
      entry.response.claimed === true || entry.response.reason === undefined ? 200 : 409,
    );
  }
});
