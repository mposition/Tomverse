// Who may call the ops-observer internal routes: off means 404 everywhere,
// a short or duplicated secret authenticates nothing, the wrong bearer is 401,
// and the digest service is refused advance and confirm with 403.

import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_SERVICES, opsObserverCaller } from "../scripts/ops-observer/route-auth-core.mjs";

const PAGE = "p".repeat(32);
const DIGEST = "d".repeat(40);
const env = { OPS_OBSERVER_SECRET: PAGE, OPS_OBSERVER_DIGEST_SECRET: DIGEST };
const call = (route, bearer, environment = env) =>
  opsObserverCaller({ route, authorization: bearer === undefined ? undefined : `Bearer ${bearer}`, env: environment });

test("each service reaches its own routes", () => {
  for (const route of Object.keys(ROUTE_SERVICES).filter((name) => name !== "digest")) {
    assert.deepEqual(call(route, PAGE), { service: "page" }, route);
  }
  assert.deepEqual(call("state", DIGEST), { service: "digest" });
  assert.deepEqual(call("ops-snapshot", DIGEST), { service: "digest" });
  assert.deepEqual(call("digest", DIGEST), { service: "digest" });
});

test("the page service is refused the digest submission", () => {
  // The page service holds the page webhook from S2 (decision D5a); it does
  // not also write the owner's daily record.
  assert.deepEqual(call("digest", PAGE), { status: 403 });
});

test("the digest service is refused advance and confirm", () => {
  assert.deepEqual(call("advance", DIGEST), { status: 403 });
  assert.deepEqual(call("confirm", DIGEST), { status: 403 });
});

test("with no usable secret every route is 404, whatever the bearer", () => {
  for (const environment of [
    {},
    { OPS_OBSERVER_SECRET: "short" },
    { OPS_OBSERVER_SECRET: PAGE, OPS_OBSERVER_DIGEST_SECRET: PAGE },
  ]) {
    for (const route of Object.keys(ROUTE_SERVICES)) {
      assert.deepEqual(call(route, PAGE, environment), { status: 404 });
    }
  }
});

test("one usable secret admits only its own service", () => {
  assert.deepEqual(call("advance", PAGE, { OPS_OBSERVER_SECRET: PAGE }), { service: "page" });
  assert.deepEqual(call("state", DIGEST, { OPS_OBSERVER_SECRET: PAGE }), { status: 401 });
  assert.deepEqual(call("state", DIGEST, { OPS_OBSERVER_DIGEST_SECRET: DIGEST }), { service: "digest" });
  assert.deepEqual(call("state", PAGE, { OPS_OBSERVER_DIGEST_SECRET: DIGEST, OPS_OBSERVER_SECRET: "short" }), { status: 401 });
});

test("a missing, malformed or wrong bearer is 401", () => {
  assert.deepEqual(call("state", undefined), { status: 401 });
  assert.deepEqual(call("state", ""), { status: 401 });
  assert.deepEqual(call("state", `${PAGE}x`), { status: 401 });
  assert.deepEqual(opsObserverCaller({ route: "state", authorization: PAGE, env }), { status: 401 });
  assert.deepEqual(opsObserverCaller({ route: "state", authorization: `bearer ${PAGE}`, env }), { status: 401 });
});

test("an unknown route is 404 before anything else", () => {
  for (const route of ["", "genesis", "__proto__", "constructor", "toString"]) {
    assert.deepEqual(call(route, PAGE), { status: 404 }, route);
  }
});
