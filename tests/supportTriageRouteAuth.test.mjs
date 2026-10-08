import assert from "node:assert/strict";
import { test } from "node:test";

const auth = await import("../lib/supportTriageRouteAuth.ts");

// The support-triage route secrets (docs/policy/support-triage.md §3).

const SECRET = "s".repeat(32);

test("a route accepts only its own Bearer secret of at least 32 characters", () => {
  const env = { SUPPORT_TRIAGE_RETENTION_SECRET: SECRET, SUPPORT_TRIAGE_RUN_SECRET: "r".repeat(32) };
  const ok = (header, name = "SUPPORT_TRIAGE_RETENTION_SECRET", e = env) =>
    auth.isSupportTriageRouteAuthorized(header, name, e);
  assert.equal(ok(`Bearer ${SECRET}`), true);
  assert.equal(ok(null), false);
  assert.equal(ok(SECRET), false);
  assert.equal(ok(`bearer ${SECRET}`), false);
  assert.equal(ok("Bearer "), false);
  assert.equal(ok(`Bearer ${SECRET}x`), false);
  // Another route's secret does not open this one.
  assert.equal(ok(`Bearer ${"r".repeat(32)}`), false);
  // No secret, or one shorter than 32, closes the route even to that value.
  assert.equal(ok(`Bearer ${SECRET}`, "SUPPORT_TRIAGE_HEARTBEAT_SECRET"), false);
  const short = "q".repeat(31);
  assert.equal(ok(`Bearer ${short}`, "SUPPORT_TRIAGE_RETENTION_SECRET", { SUPPORT_TRIAGE_RETENTION_SECRET: short }), false);
});

test("triage is enabled only by the exact string true", () => {
  for (const value of [undefined, "", "1", "TRUE", "yes", " true"]) {
    assert.equal(auth.isSupportTriageEnabled({ SUPPORT_TRIAGE_ENABLED: value }), false, String(value));
  }
  assert.equal(auth.isSupportTriageEnabled({ SUPPORT_TRIAGE_ENABLED: "true" }), true);
});

test("the route files export POST only and answer no-store, success or failure", async () => {
  const { readFileSync } = await import("node:fs");
  for (const route of ["retention", "heartbeat", "run"]) {
    const source = readFileSync(new URL(`../app/api/internal/support-triage/${route}/route.ts`, import.meta.url), "utf8");
    const handlers = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(handlers, ["POST"], route);
    assert.equal(source.match(/"Cache-Control": "no-store"/g)?.length, 2, route);
    // The request body is never read.
    assert.ok(!/request\.(json|text|formData|arrayBuffer|body)/.test(source), route);
  }
  const routes = readFileSync(new URL("../lib/supportTriageRoutes.ts", import.meta.url), "utf8");
  assert.ok(!/request\.(json|text|formData|arrayBuffer|body)/.test(routes));
});
