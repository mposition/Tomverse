import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, mock, test } from "node:test";

// Orchestration policy version 20, section 4, at the three write routes:
// claim, recover and the automatic promotion tick.
//
// - A request without the identity headers comes from an orchestrator built
//   before version 20. It is served exactly as before and admitted nowhere:
//   the web deploys first, while that orchestrator is still running.
// - With the headers, the admission is the route's first transaction, before
//   the body, the switches or any write. A second admission of the same
//   request id is 409 `duplicate_request`; an admission that cannot commit is
//   503 `amux_database_busy`, with nothing after it run.
// - Once a receipt of the request may have committed, the route never answers
//   one of the three "nothing committed" 503 reasons; it answers
//   `amux_outcome_unknown` (section 1).
//
// The database is faked at the store (the admission insert) and at the
// transaction; the route budget, the admission plumbing and the error mapping
// are the real ones. The same rules against PostgreSQL:
// tests/integration/amux-orchestration-halt.db.test.ts.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const REQUEST = "0b8e9a52-6d8c-4f0e-9b1a-2c3d4e5f6a7b";
const INSTANCE = "1c9f0b63-7e9d-4a1f-8c2b-3d4e5f6a7b8c";

type World = {
  log: string[];
  admissions: Array<{ requestId: string; instanceId: string; callKind: string; budgetMs: number }>;
  admission: "admitted" | "duplicate" | "fails";
  executionApiEnabled: boolean;
  sweepMarksReceipt: boolean;
  reclaimError: Error | null;
  tick: () => Promise<unknown>;
};

const freshWorld = (): World => ({
  log: [],
  admissions: [],
  admission: "admitted",
  executionApiEnabled: false,
  sweepMarksReceipt: false,
  reclaimError: null,
  tick: async () => ({ promoted: false, reason: "no_grant", expired: 0 }),
});
let world = freshWorld();

type Boundary = typeof import("../../lib/amux/dbBoundary.ts");
let boundary: Boundary | null = null;

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({ $executeRaw: async () => 0, $queryRaw: async () => [] }),
    },
    prismaPoolUsage: () => null,
  },
});
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), {
  namedExports: {
    insertAmuxOrchestratorAdmission: async (
      _tx: unknown,
      input: World["admissions"][number],
    ) => {
      world.log.push("admit");
      world.admissions.push(input);
      if (world.admission === "fails") throw Object.assign(new Error("insert failed"), { code: "P2024" });
      if (world.admission === "duplicate") return { admitted: false };
      return { admitted: true, deadlineAt: new Date(Date.now() + input.budgetMs) };
    },
    lockAmuxOrchestratorAdmission: async () => ({ acked: false, resolved: false }),
    amuxOrchestratorReceiptInsertSql: () => {
      throw new Error("no receipt SQL in this test");
    },
  },
});
mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => true },
});
mock.module(mod("lib/amux/executionGate.ts"), {
  namedExports: { isAmuxExecutionApiEnabled: () => world.executionApiEnabled },
});
mock.module(mod("lib/amux/claimDeadline.ts"), {
  namedExports: {
    AMUX_CLAIM_ROUTE_BUDGET_MS: 12_000,
    anchorAmuxClaimDeadline: async () => {
      world.log.push("anchor");
    },
  },
});
mock.module(mod("lib/amux/store.ts"), {
  namedExports: {
    recordAmuxClaimRefusal: async (reason: string) => {
      world.log.push(`refusal:${reason}`);
    },
    claimUnownedTodo: async () => {
      throw new Error("not reached");
    },
    getAuthoritativeSchedulerFacts: async () => null,
  },
});
mock.module(mod("lib/amux/routing.ts"), {
  namedExports: {
    buildAmuxRoutingSnapshot: async () => {
      throw new Error("not reached");
    },
  },
});
mock.module(mod("lib/amux/telemetry.ts"), {
  namedExports: {
    sweepExpiredAmuxQuotaObservations: async () => {
      world.log.push("sweep");
      // What a committed sweep with deleted rows does in withAmuxDbBoundary.
      if (world.sweepMarksReceipt) boundary!.markAmuxRouteOrchestratorReceiptsCommitting();
      return 3;
    },
  },
});
mock.module(mod("lib/amux/execution.ts"), {
  namedExports: {
    reclaimExpiredAmuxExecutions: async () => {
      world.log.push("reclaim_executions");
      if (world.reclaimError) throw world.reclaimError;
      return 0;
    },
    reclaimExpiredAmuxClaims: async () => {
      world.log.push("reclaim_claims");
      return 0;
    },
  },
});
mock.module(mod("lib/amux/autoPromotionService.ts"), {
  namedExports: {
    tickAutoPromotion: () => {
      world.log.push("tick");
      return world.tick();
    },
  },
});

const load = async () => {
  boundary = await import(mod("lib/amux/dbBoundary.ts"));
  return {
    boundary: boundary!,
    claim: (await import(mod("app/api/internal/amux/claim/route.ts"))).POST as (r: Request) => Promise<Response>,
    recover: (await import(mod("app/api/internal/amux/execution/recover/route.ts"))).POST as (
      r: Request,
    ) => Promise<Response>,
    tick: (await import(mod("app/api/internal/amux/auto-promotion/tick/route.ts"))).POST as (
      r: Request,
    ) => Promise<Response>,
  };
};
let loaded: ReturnType<typeof load> | undefined;
const routes = () => (loaded ??= load());

const SWITCH = "TOMVERSE_AMUX_BOARD_AUTO_PROMOTE";
const previousSwitch = process.env[SWITCH];
after(() => {
  if (previousSwitch === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = previousSwitch;
});

const identity = { "x-amux-request-id": REQUEST, "x-amux-instance-id": INSTANCE };

const post = (path: string, headers: Record<string, string> = {}, body = "{}") =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x", ...headers },
    body,
  });

const claimBody = JSON.stringify({
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
        preferred_worker: null,
        selected_worker: null,
        preferred_score: null,
        selected_score: null,
        candidates: [],
      },
    },
  },
});

const reset = (changes: Partial<World> = {}) => {
  world = { ...freshWorld(), ...changes };
  process.env[SWITCH] = "enabled";
};

test("without identity headers every write route is served as before and admits nothing", async () => {
  const { claim, recover, tick } = await routes();

  reset();
  const claimed = await claim(post("/api/internal/amux/claim", {}, claimBody));
  assert.equal(claimed.status, 409);
  assert.deepEqual(await claimed.json(), { claimed: false, reason: "execution_api_disabled" });
  assert.deepEqual(world.log, ["anchor", "refusal:execution_api_disabled"]);

  reset();
  const recovered = await recover(post("/api/internal/amux/execution/recover"));
  assert.equal(recovered.status, 409);
  assert.deepEqual(await recovered.json(), {
    recovered: false,
    reason: "execution_api_disabled",
    quota_observations_deleted: 3,
  });
  assert.deepEqual(world.log, ["sweep"]);

  reset();
  const ticked = await tick(post("/api/internal/amux/auto-promotion/tick"));
  assert.equal(ticked.status, 200);
  assert.deepEqual(await ticked.json(), { promoted: false, reason: "no_grant", expired: 0 });
  assert.deepEqual(world.log, ["tick"]);

  // And a receipt mark outside an admitted request records nothing: the
  // same failure keeps its old answer.
  reset({ executionApiEnabled: true, sweepMarksReceipt: true });
  world.reclaimError = new boundary!.AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", "execution_recovery_read");
  const late = await recover(post("/api/internal/amux/execution/recover"));
  assert.equal(late.status, 503);
  assert.deepEqual(await late.json(), {
    error: "AMUX database deadline exceeded.",
    reason: "amux_database_deadline_exceeded",
  });
  assert.equal(world.admissions.length, 0);
});

test("with identity headers the admission is the route's first transaction, with the route's budget", async () => {
  const { claim, recover, tick } = await routes();
  for (const [route, path, body, callKind, budgetMs, first] of [
    [claim, "/api/internal/amux/claim", claimBody, "claim", 12_000, "anchor"],
    [recover, "/api/internal/amux/execution/recover", "{}", "recover", 12_000, "sweep"],
    [tick, "/api/internal/amux/auto-promotion/tick", "{}", "auto_promotion_tick", 27_000, "tick"],
  ] as const) {
    reset();
    const response = await route(post(path, identity, body));
    assert.ok(response.status === 200 || response.status === 409, `${callKind}: ${response.status}`);
    assert.deepEqual(world.admissions, [
      { requestId: REQUEST, instanceId: INSTANCE, callKind, budgetMs },
    ]);
    assert.deepEqual(world.log.slice(0, 2), ["admit", first], callKind);
  }
});

test("a second admission of the same request id is 409 duplicate_request, and nothing else runs", async () => {
  const { claim, recover, tick } = await routes();
  for (const [route, path, body] of [
    [claim, "/api/internal/amux/claim", claimBody],
    [recover, "/api/internal/amux/execution/recover", "{}"],
    [tick, "/api/internal/amux/auto-promotion/tick", "{}"],
  ] as const) {
    reset({ admission: "duplicate" });
    const response = await route(post(path, identity, body));
    assert.equal(response.status, 409, path);
    assert.deepEqual(await response.json(), { error: "Duplicate request.", reason: "duplicate_request" });
    assert.deepEqual(world.log, ["admit"], path);
  }
});

test("an admission that cannot commit is 503 amux_database_busy, and nothing else runs", async () => {
  const { claim, recover, tick } = await routes();
  for (const [route, path, body] of [
    [claim, "/api/internal/amux/claim", claimBody],
    [recover, "/api/internal/amux/execution/recover", "{}"],
    [tick, "/api/internal/amux/auto-promotion/tick", "{}"],
  ] as const) {
    reset({ admission: "fails" });
    const response = await route(post(path, identity, body));
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), {
      error: "AMUX database is busy.",
      reason: "amux_database_busy",
    });
    assert.deepEqual(world.log, ["admit"], path);
  }
});

test("a malformed or partial identity is refused before any transaction", async () => {
  const { claim, recover, tick } = await routes();
  const partials: Array<Record<string, string>> = [
    { "x-amux-request-id": REQUEST },
    { "x-amux-instance-id": INSTANCE },
    { "x-amux-request-id": "not-a-uuid", "x-amux-instance-id": INSTANCE },
  ];
  for (const headers of partials) {
    for (const [route, path, body] of [
      [claim, "/api/internal/amux/claim", claimBody],
      [recover, "/api/internal/amux/execution/recover", "{}"],
      [tick, "/api/internal/amux/auto-promotion/tick", "{}"],
    ] as const) {
      reset();
      const response = await route(post(path, headers, body));
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "Invalid request." });
      assert.deepEqual(world.log, [], path);
    }
  }
});

test("after a receipt may have committed, a deadline after the sweep is an unknown outcome, not a deadline", async () => {
  const { recover } = await routes();
  // Section 1 and the completion list: "recover의 sweep 뒤 기한 초과".
  reset({ executionApiEnabled: true, sweepMarksReceipt: true });
  world.reclaimError = new boundary!.AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", "execution_recovery_read");
  const response = await recover(post("/api/internal/amux/execution/recover", identity));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.reason, "amux_outcome_unknown");
  assert.match(body.incident_id, /^[0-9a-f-]{36}$/);

  // The same failure with no receipt committed is still the deadline: nothing
  // was committed, and the orchestrator may acknowledge it as such.
  reset({ executionApiEnabled: true, sweepMarksReceipt: false });
  world.reclaimError = new boundary!.AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", "execution_recovery_read");
  const plain = await recover(post("/api/internal/amux/execution/recover", identity));
  assert.equal(plain.status, 503);
  assert.equal((await plain.json()).reason, "amux_database_deadline_exceeded");

  // A prior sweep receipt wins over a nested raw-query timeout in the next
  // recovery step: this route may already have committed a state change.
  reset({ executionApiEnabled: true, sweepMarksReceipt: true });
  world.reclaimError = Object.assign(new Error("query canceled"), {
    code: "P2010",
    meta: { driverAdapterError: { kind: "postgres", code: "57014" } },
  });
  const afterReceipt = await recover(post("/api/internal/amux/execution/recover", identity));
  assert.equal(afterReceipt.status, 503);
  assert.equal((await afterReceipt.json()).reason, "amux_outcome_unknown");
});

test("after a receipt may have committed, none of the three nothing-committed answers is sent by the tick", async () => {
  const { tick } = await routes();
  // "tick의 grant 만료 뒤 기한 초과": a grant expiry committed its receipt,
  // then the tick failed with each of the three.
  for (const code of [
    "AMUX_DB_DEADLINE_EXCEEDED",
    "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
    "AMUX_DB_READ_BUSY",
  ] as const) {
    reset({
      tick: async () => {
        boundary!.markAmuxRouteOrchestratorReceiptsCommitting();
        throw new boundary!.AmuxDbBoundaryError(code, "auto_promotion");
      },
    });
    const response = await tick(post("/api/internal/amux/auto-promotion/tick", identity));
    assert.equal(response.status, 503, code);
    assert.equal((await response.json()).reason, "amux_outcome_unknown", code);
  }
  // A mark taken back (a COMMIT the deadline trigger refused) is no receipt.
  reset({
    tick: async () => {
      const forget = boundary!.markAmuxRouteOrchestratorReceiptsCommitting();
      forget();
      throw new boundary!.AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", "auto_promotion");
    },
  });
  const refused = await tick(post("/api/internal/amux/auto-promotion/tick", identity));
  assert.equal((await refused.json()).reason, "amux_database_deadline_exceeded");
});

test("a transaction that found its admission closed is answered as an unknown outcome", async () => {
  const { tick } = await routes();
  reset({
    tick: async () => {
      throw new boundary!.AmuxDbBoundaryError("AMUX_DB_ADMISSION_CLOSED", "auto_promotion");
    },
  });
  const response = await tick(post("/api/internal/amux/auto-promotion/tick", identity));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "amux_outcome_unknown");
});
