import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let calls = [];
mock.module(mod("lib/autoRouterRecAgent.ts"), { namedExports: {
  claimNextRecommendation: async () => { calls.push("legacy"); return null; },
  parseRecommendationId: (id) => id === "cycle:0" ? { cycleId: "cycle", index: 0 } : null,
  recordRecommendationResult: async () => { calls.push("router-result"); return { ok: true, changed: true }; },
} });
mock.module(mod("lib/dailyProductAgentStore.ts"), { namedExports: {
  claimDailyProductTask: async () => { calls.push("daily"); return null; },
  recordDailyProductResult: async (input) => { calls.push(input); return { ok: true, changed: true }; },
} });
const claimRoute = await import(mod("app/api/internal/auto-router/recommendations/claim/route.ts"));
const resultRoute = await import(mod("app/api/internal/auto-router/recommendations/result/route.ts"));
const dailyClaimRoute = await import(mod("app/api/internal/product-improvements/claim/route.ts"));
const dailyResultRoute = await import(mod("app/api/internal/product-improvements/result/route.ts"));
const oldSecret = process.env.AUTO_ROUTER_REC_AGENT_SECRET, oldSwitch = process.env.DAILY_PRODUCT_AGENT_ENABLED;
const secret = "test-placeholder-only-".repeat(3);
const body = { id: "scout.one", claimId: "11111111-2222-4333-8444-555555555555", outcome: "failed", reason: "no_change" };
const request = ({ daily = true, auth = true, payload } = {}) => new Request("https://app.example.test/api/internal/auto-router/recommendations/claim", {
  method: "POST", headers: { ...(auth ? { authorization: `Bearer ${secret}` } : {}), ...(daily ? { "x-autorec-work-mode": "daily-product" } : {}), "content-type": "application/json" },
  body: JSON.stringify(payload ?? {}),
});
test.beforeEach(() => { calls = []; process.env.AUTO_ROUTER_REC_AGENT_SECRET = secret; delete process.env.DAILY_PRODUCT_AGENT_ENABLED; });
test.after(() => {
  for (const [key, old] of [["AUTO_ROUTER_REC_AGENT_SECRET", oldSecret], ["DAILY_PRODUCT_AGENT_ENABLED", oldSwitch]]) {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
});

test("the secret and explicit daily activation fence the expanded source", async () => {
  assert.equal((await claimRoute.POST(request({ auth: false }))).status, 404);
  assert.equal((await claimRoute.POST(request())).status, 404);
  assert.deepEqual(calls, []);
  assert.equal((await claimRoute.POST(request({ daily: false }))).status, 204);
  process.env.DAILY_PRODUCT_AGENT_ENABLED = "true";
  assert.equal((await claimRoute.POST(request())).status, 204);
  assert.deepEqual(calls, ["legacy", "daily"]);
});

test("stopping new claims still allows the current claim to report an outcome", async () => {
  const response = await resultRoute.POST(request({ payload: body }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [body]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("legacy callers cannot report Scout results and arbitrary PR hosts never reach storage", async () => {
  assert.equal((await resultRoute.POST(request({ daily: false, payload: body }))).status, 400);
  assert.equal((await resultRoute.POST(request({ auth: false, payload: body }))).status, 404);
  assert.equal((await resultRoute.POST(request({ payload: { id: body.id, claimId: body.claimId, outcome: "pr_opened", prUrl: "https://attacker.test/pull/1" } }))).status, 400);
  assert.equal((await resultRoute.POST(request({ payload: { ...body, extra: "unadmitted" } }))).status, 400);
  assert.deepEqual(calls, []);
});

test("existing router claims retain their original result path", async () => {
  assert.equal((await resultRoute.POST(request({ payload: { ...body, id: "cycle:0" } }))).status, 200);
  assert.deepEqual(calls, ["router-result"]);
});

test("dedicated daily endpoints require the mode and preserve auth, switch and result fences", async () => {
  assert.equal((await dailyClaimRoute.POST(request({ daily: false }))).status, 404);
  assert.equal((await dailyResultRoute.POST(request({ daily: false, payload: body }))).status, 404);
  assert.equal((await dailyClaimRoute.POST(request())).status, 404);
  process.env.DAILY_PRODUCT_AGENT_ENABLED = "true";
  assert.equal((await dailyClaimRoute.POST(request({ auth: false }))).status, 404);
  assert.equal((await dailyClaimRoute.POST(request())).status, 204);
  assert.equal((await dailyResultRoute.POST(request({ payload: body }))).status, 200);
  assert.equal(calls[0], "daily");
  assert.deepEqual(calls[1], body);
});
