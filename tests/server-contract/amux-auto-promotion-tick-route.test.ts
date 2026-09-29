import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, mock, test } from "node:test";

// The internal auto-promotion tick route: its gates, its route budget, and the
// failure shape it shares with the other AMUX internal routes. The service is
// mocked; the route budget, the AMUX error mapping and the core switch are real.

const ROOT = resolve(import.meta.dirname, "..", "..");
const moduleUrl = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

let authorized = true;
let tickCalls = 0;
let tick: () => Promise<unknown> = async () => ({ promoted: false, reason: "no_grant", expired: 0 });

mock.module(moduleUrl("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => authorized },
});
mock.module(moduleUrl("lib/amux/autoPromotionService.ts"), {
  namedExports: {
    tickAutoPromotion: () => {
      tickCalls += 1;
      return tick();
    },
  },
});

// Loaded after the mocks above, and once: the route and the error class have
// to come from the same module instances the route itself sees.
const load = async () => ({
  ...(await import(moduleUrl("lib/amux/dbBoundary.ts"))),
  ...(await import(moduleUrl("lib/amux/autoPromotionCore.ts"))),
  POST: (await import(moduleUrl("app/api/internal/amux/auto-promotion/tick/route.ts"))).POST,
});
let loaded: ReturnType<typeof load> | undefined;
const modules = () => (loaded ??= load());

const SWITCH = "TOMVERSE_AMUX_BOARD_AUTO_PROMOTE";
const previousSwitch = process.env[SWITCH];
after(() => {
  if (previousSwitch === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = previousSwitch;
});

const call = async (body = "{}") =>
  (await modules()).POST(
    new Request("http://localhost/api/internal/amux/auto-promotion/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );

const reset = async (switchValue: string | undefined) => {
  const { AUTO_PROMOTION_APPLY_ENV } = await modules();
  assert.equal(AUTO_PROMOTION_APPLY_ENV, SWITCH);
  authorized = true;
  tickCalls = 0;
  if (switchValue === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = switchValue;
};

test("credential, body and switch refuse before the tick runs", async () => {
  await reset("enabled");
  authorized = false;
  const unauthorized = await call();
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });

  await reset("enabled");
  const invalid = await call(JSON.stringify({ extra: true }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid request." });
  assert.equal(invalid.headers.get("Cache-Control"), "no-store");

  await reset(undefined);
  const closed = await call();
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), { promoted: false, reason: "apply_disabled", expired: 0 });
  assert.equal(tickCalls, 0);
});

test("the tick runs inside its route budget and a finished tick answers with its own body", async () => {
  await reset("enabled");
  const { AUTO_TICK_ROUTE_BUDGET_MS, amuxRouteHasBudgetForMs } = await modules();
  let insideBudget: boolean | null = null;
  let beyondBudget: boolean | null = null;
  tick = async () => {
    insideBudget = amuxRouteHasBudgetForMs(AUTO_TICK_ROUTE_BUDGET_MS - 1_000);
    beyondBudget = amuxRouteHasBudgetForMs(AUTO_TICK_ROUTE_BUDGET_MS + 1_000);
    return { promoted: false, reason: "route_budget_exhausted", expired: 2 };
  };
  const response = await call();
  assert.equal(tickCalls, 1);
  assert.equal(insideBudget, true);
  assert.equal(beyondBudget, false);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { promoted: false, reason: "route_budget_exhausted", expired: 2 });
});

test("a deadline answers like every AMUX internal route: 503 with the deadline reason", async () => {
  await reset("enabled");
  const { AmuxDbBoundaryError } = await modules();
  tick = async () => {
    throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", "auto_promotion");
  };
  const response = await call();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "AMUX database deadline exceeded.",
    reason: "amux_database_deadline_exceeded",
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("an unexpected failure is an opaque 500 with an incident id, never the tick body or a message", async () => {
  await reset("enabled");
  tick = async () => {
    throw new Error("secret detail from the database");
  };
  const errors = mock.method(console, "error", () => {});
  try {
    const response = await call();
    assert.equal(response.status, 500);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["error", "incident_id"]);
    assert.equal(body.error, "Internal server error.");
    assert.equal(typeof body.incident_id, "string");
    assert.equal(response.headers.get("X-AMUX-Incident-ID"), body.incident_id);
    assert.equal(JSON.stringify(body).includes("secret"), false);
  } finally {
    errors.mock.restore();
  }
});
