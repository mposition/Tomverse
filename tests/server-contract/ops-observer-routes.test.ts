// The ops-observer internal routes (docs/policy/sre-ops.md §3 rules 4 and 7,
// §6, §7, §8): the caller is decided before the body is read, the body is
// capped and parsed closed before the store is called, the store's closed
// answer is passed through no-store, a late run is 409, and a failure is a
// 500 whose log line carries no message.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

import { S2_PAGE_KEYS, initialKeyState } from "../../scripts/ops-observer/classify-core.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const PAGE = "p".repeat(40);
const DIGEST = "d".repeat(40);

class TestApiSecurityError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
class TestLateError extends Error {}

type Call = { fn: string; input: unknown; rest: unknown[] };
const world: { calls: Call[]; next: unknown; throws: unknown } = { calls: [], next: null, throws: null };
const storeFn = (fn: string) => async (input: unknown, ...rest: unknown[]) => {
  world.calls.push({ fn, input, rest });
  if (world.throws) throw world.throws;
  return world.next;
};

let routes: Record<string, (request: Request) => Promise<Response>>;

before(async () => {
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ApiSecurityError: TestApiSecurityError,
      // The same contract as the real reader: the declared length, then the bytes.
      readLimitedText: async (request: Request, maxBytes: number) => {
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new TestApiSecurityError(413, "REQUEST_BODY_TOO_LARGE", "too large");
        }
        const text = await request.text();
        if (Buffer.byteLength(text, "utf8") > maxBytes) throw new TestApiSecurityError(413, "REQUEST_BODY_TOO_LARGE", "too large");
        return text;
      },
    },
  });
  mock.module(mod("lib/opsObserverTransaction.ts"), {
    namedExports: {
      OpsObserverLateError: TestLateError,
      isBudgetInsufficient: (error: unknown) => (error as { code?: string })?.code === "OB001",
    },
  });
  mock.module(mod("lib/opsObserverStore.ts"), {
    namedExports: {
      readOpsObserverState: storeFn("read"),
      advanceOpsObserverState: storeFn("advance"),
      confirmOpsObserverDelivery: storeFn("confirm"),
    },
  });
  routes = {
    state: (await import(mod("app/api/internal/ops-observer/state/route.ts"))).POST,
    advance: (await import(mod("app/api/internal/ops-observer/advance/route.ts"))).POST,
    confirm: (await import(mod("app/api/internal/ops-observer/confirm/route.ts"))).POST,
  };
});

beforeEach(() => {
  world.calls = [];
  world.next = { trust: "trusted" };
  world.throws = null;
  process.env.OPS_OBSERVER_SECRET = PAGE;
  process.env.OPS_OBSERVER_DIGEST_SECRET = DIGEST;
});

const deadline = () => new Date(Date.now() + 60_000).toISOString();
const DELIVERY = "11111111-1111-4111-8111-111111111111";
const bodies: Record<string, () => unknown> = {
  state: () => ({ runDeadline: deadline(), ownerDate: "2026-10-07" }),
  confirm: () => ({ runDeadline: deadline(), deliveryId: DELIVERY, runId: "run-1" }),
  advance: () => ({
    runDeadline: deadline(),
    runId: "run-1",
    baseGenesisId: DELIVERY,
    baseGeneration: 3,
    keys: Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()])),
    reservation: null,
  }),
};
const post = (route: string, bearer: string | null, body: unknown = bodies[route]()) =>
  routes[route](
    new Request(`https://tomverse.app/api/internal/ops-observer/${route}`, {
      method: "POST",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

test("with no usable secret every route is 404 and nothing is called", async () => {
  delete process.env.OPS_OBSERVER_SECRET;
  delete process.env.OPS_OBSERVER_DIGEST_SECRET;
  for (const route of ["state", "advance", "confirm"]) {
    const response = await post(route, PAGE);
    assert.equal(response.status, 404, route);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
  assert.deepEqual(world.calls, []);
});

test("a wrong bearer is 401, the digest service on advance and confirm is 403", async () => {
  assert.equal((await post("state", "x".repeat(40))).status, 401);
  assert.equal((await post("state", null)).status, 401);
  assert.equal((await post("advance", DIGEST)).status, 403);
  assert.equal((await post("confirm", DIGEST)).status, 403);
  assert.deepEqual(world.calls, []);
  assert.equal((await post("state", DIGEST)).status, 200);
  assert.equal(world.calls.length, 1);
});

test("an oversized or malformed body is refused before the store", async () => {
  const big = await post("state", PAGE, JSON.stringify({ runDeadline: deadline(), ownerDate: "2026-10-07", pad: "x".repeat(17_000) }));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { refused: "too_large" });
  const late = await post("state", PAGE, { runDeadline: new Date(Date.now() - 1).toISOString(), ownerDate: "2026-10-07" });
  assert.deepEqual([late.status, await late.json()], [400, { refused: "deadline_invalid" }]);
  const extra = await post("confirm", PAGE, { ...(bodies.confirm() as object), status: "confirmed" });
  assert.deepEqual([extra.status, await extra.json()], [400, { refused: "shape" }]);
  const capped = await post("advance", PAGE, { ...(bodies.advance() as object), capped: true });
  assert.deepEqual([capped.status, await capped.json()], [400, { refused: "shape" }]);
  assert.deepEqual(world.calls, []);
});

test("each route hands the store its parsed request and passes its answer through, no-store", async () => {
  world.next = { result: "advanced", sendPermitted: false, deliveryId: null, heartbeatWithheld: false, generation: 4 };
  const response = await post("advance", PAGE);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), world.next);
  const [call] = world.calls;
  assert.equal(call.fn, "advance");
  const input = call.input as { runDeadline: Date; baseGeneration: number; reservation: unknown };
  assert.ok(input.runDeadline instanceof Date);
  assert.equal(input.baseGeneration, 3);
  assert.equal(input.reservation, null);

  world.calls = [];
  await post("confirm", PAGE);
  assert.deepEqual(
    (world.calls[0].input as { deliveryId: string; runId: string }),
    { runDeadline: (world.calls[0].input as { runDeadline: Date }).runDeadline, deliveryId: DELIVERY, runId: "run-1" },
  );
  world.calls = [];
  await post("state", PAGE);
  assert.ok((world.calls[0].input as Date) instanceof Date);
  // The owner date reaches the store as the budget date (the client is the default).
  assert.deepEqual(world.calls[0].rest, [undefined, "2026-10-07"]);
  world.calls = [];
  assert.equal((await post("state", PAGE, { runDeadline: deadline() })).status, 400);
  assert.equal((await post("state", PAGE, { runDeadline: deadline(), ownerDate: "2026-02-30" })).status, 400);
  assert.deepEqual(world.calls, []);
});

test("a late run is 409, and a failure is a 500 that logs no message", async () => {
  world.throws = new TestLateError("late");
  assert.deepEqual([(await post("state", PAGE)).status], [409]);
  world.throws = Object.assign(new Error("budget"), { code: "OB001" });
  const budget = await post("advance", PAGE);
  assert.deepEqual([budget.status, await budget.json()], [409, { error: "late" }]);

  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    world.throws = Object.assign(new Error("secret detail from the database"), { code: "P2010" });
    const failed = await post("confirm", PAGE);
    assert.deepEqual([failed.status, await failed.json()], [500, { error: "internal" }]);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), { event: "ops_observer_route_failed", route: "confirm", errorName: "Error", errorCode: "P2010" });
  assert.doesNotMatch(logged[0], /secret detail/);
});
