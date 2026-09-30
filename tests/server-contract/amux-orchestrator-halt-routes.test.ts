import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Orchestration policy version 20, sections 4 and 5: the acknowledgement and
// the halt record and state routes, the wire shapes the orchestrator parses.
// The service is faked; its database behaviour is the routing lane's
// (tests/integration/amux-orchestration-halt.db.test.ts).

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const REQUEST = "0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b";
const OTHER = "1c9f0b63-7e9d-4a1f-8c2b-3d4e5f6a7b8c";

let authorized = true;
const calls: Array<{ name: string; input: unknown }> = [];
let ackDecision: unknown = { acked: true, write: "set_acked" };
let serviceError: Error | null = null;

const haltRow = {
  haltId: OTHER,
  haltKey: REQUEST,
  reasonCode: "claim_outcome_unknown",
  requestId: REQUEST,
  openedAt: "2026-09-30T01:02:03.000Z",
  cleared: false,
};

mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => authorized },
});
mock.module(mod("lib/amux/orchestratorHaltService.ts"), {
  namedExports: {
    acknowledgeAmuxOrchestratorWrite: async (input: unknown) => {
      calls.push({ name: "ack", input });
      if (serviceError) throw serviceError;
      return ackDecision;
    },
    openAmuxOrchestratorHalt: async (input: unknown) => {
      calls.push({ name: "open", input });
      if (serviceError) throw serviceError;
      return { halt: haltRow, created: true };
    },
    readAmuxOrchestratorHaltStateResolved: async (input: unknown) => {
      calls.push({ name: "state", input });
      if (serviceError) throw serviceError;
      return {
        openHaltCount: 1,
        openHalts: [haltRow],
        pendingCount: 2,
        latestDeadlineAt: "2026-09-30T01:02:30.000Z",
        retryAfterMs: 7_000,
        humanRequiredCount: 1,
        humanRequired: [{ requestId: REQUEST, callKind: "claim", receiptCount: 2 }],
        halts: [{ haltKey: REQUEST, haltId: OTHER, cleared: false }],
      };
    },
  },
});

const load = async () => ({
  boundary: await import(mod("lib/amux/dbBoundary.ts")),
  ack: (await import(mod("app/api/internal/amux/orchestrator/ack/route.ts"))).POST as (
    r: Request,
  ) => Promise<Response>,
  halt: await import(mod("app/api/internal/amux/orchestrator/halt/route.ts")),
});
let loaded: ReturnType<typeof load> | undefined;
const routes = () => (loaded ??= load());

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const reset = () => {
  authorized = true;
  calls.length = 0;
  ackDecision = { acked: true, write: "set_acked" };
  serviceError = null;
};

test("an acknowledgement answers acked, or 409 with the closed refusal the orchestrator halts on", async () => {
  const { ack } = await routes();
  reset();
  const ok = await ack(post("/api/internal/amux/orchestrator/ack", { request_id: REQUEST, kind: "definite" }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { acked: true });
  assert.deepEqual(calls, [{ name: "ack", input: { requestId: REQUEST, kind: "definite" } }]);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");

  reset();
  ackDecision = { acked: false, reason: "receipts_present" };
  const refused = await ack(post("/api/internal/amux/orchestrator/ack", { request_id: REQUEST, kind: "no_commit" }));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { acked: false, reason: "receipts_present" });
});

test("an acknowledgement body is exactly a request id and a kind", async () => {
  const { ack } = await routes();
  for (const body of [
    { request_id: REQUEST },
    { request_id: REQUEST, kind: "maybe" },
    { request_id: "x", kind: "definite" },
    { request_id: REQUEST, kind: "definite", extra: 1 },
    "not json",
  ]) {
    reset();
    const response = await ack(post("/api/internal/amux/orchestrator/ack", body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "Invalid request." });
    assert.equal(calls.length, 0);
  }
  reset();
  authorized = false;
  const unauthorized = await ack(post("/api/internal/amux/orchestrator/ack", { request_id: REQUEST, kind: "definite" }));
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);
});

test("an acknowledgement that cannot reach the database is a 503 the orchestrator retries", async () => {
  const { ack, boundary } = await routes();
  reset();
  serviceError = new boundary.AmuxDbBoundaryError("AMUX_DB_NOT_STARTED", "orchestrator_ack");
  const response = await ack(post("/api/internal/amux/orchestrator/ack", { request_id: REQUEST, kind: "no_commit" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "amux_database_busy");
});

test("a halt record answers the stored halt and takes nothing that could clear one", async () => {
  const { halt } = await routes();
  reset();
  const response = await halt.POST(
    post("/api/internal/amux/orchestrator/halt", {
      halt_key: REQUEST,
      reason_code: "claim_outcome_unknown",
      request_id: REQUEST,
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    halt_id: OTHER,
    halt_key: REQUEST,
    reason_code: "claim_outcome_unknown",
    request_id: REQUEST,
    opened_at: "2026-09-30T01:02:03.000Z",
    cleared: false,
    created: true,
  });
  assert.deepEqual(calls, [
    {
      name: "open",
      input: { haltKey: REQUEST, reasonCode: "claim_outcome_unknown", requestId: REQUEST },
    },
  ]);

  for (const body of [
    { halt_key: REQUEST, reason_code: "claim_outcome_unknown" },
    { halt_key: REQUEST, reason_code: "claim_outcome_unknown", request_id: OTHER },
    { halt_key: OTHER, reason_code: "contract_violation", request_id: REQUEST },
    { halt_key: OTHER, reason_code: "operator_note" },
    { halt_key: OTHER, reason_code: "contract_violation", cleared_at: "2026-09-30T00:00:00Z" },
    { halt_key: OTHER, reason_code: "contract_violation", clear: true },
  ]) {
    reset();
    const refused = await halt.POST(post("/api/internal/amux/orchestrator/halt", body));
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
  // No other method exists on the route.
  assert.deepEqual(Object.keys(halt).filter((key) => /^[A-Z]+$/.test(key)).sort(), ["GET", "POST"]);
});

test("the halt state reports open halts, undecided and human-confirm writes, and asked-about keys", async () => {
  const { halt } = await routes();
  reset();
  const response = await halt.GET(
    new Request(`http://localhost/api/internal/amux/orchestrator/halt?halt_key=${REQUEST}`, {
      headers: { authorization: "Bearer x" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    open_halt_count: 1,
    open_halts: [
      {
        halt_id: OTHER,
        halt_key: REQUEST,
        reason_code: "claim_outcome_unknown",
        request_id: REQUEST,
        opened_at: "2026-09-30T01:02:03.000Z",
      },
    ],
    pending_count: 2,
    latest_deadline_at: "2026-09-30T01:02:30.000Z",
    retry_after_ms: 7_000,
    human_required_count: 1,
    human_required: [{ request_id: REQUEST, call_kind: "claim", receipt_count: 2 }],
    halts: [{ halt_key: REQUEST, halt_id: OTHER, cleared: false }],
  });
  assert.deepEqual(calls, [{ name: "state", input: [REQUEST] }]);

  for (const query of [
    "?halt_key=x",
    `?halt_key=${REQUEST}&halt_key=${REQUEST}`,
    `?other=${REQUEST}`,
    `?${Array.from({ length: 17 }, (_, index) => `halt_key=${REQUEST.slice(0, -2)}${String(index).padStart(2, "0")}`).join("&")}`,
  ]) {
    reset();
    const refused = await halt.GET(
      new Request(`http://localhost/api/internal/amux/orchestrator/halt${query}`, {
        headers: { authorization: "Bearer x" },
      }),
    );
    assert.equal(refused.status, 400, query);
    assert.equal(calls.length, 0);
  }

  reset();
  authorized = false;
  const unauthorized = await halt.GET(new Request("http://localhost/api/internal/amux/orchestrator/halt"));
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);
});
