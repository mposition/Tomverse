import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The recommendation status action rides the optimizer route, so it inherits
// that route's gates by construction. This pins that it does: the same order of
// checks as every other write, and nothing reaches the store before all pass.

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;

class Reauthentication extends Error {}

let session, permitted, recentAuthError, rateLimitCalls, setCalls, setResult;

mock.module("next-auth/next", { namedExports: { getServerSession: async () => session } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), {
  namedExports: {
    isAdminSession: (value) => Boolean(value?.user?.id),
    hasAdminPermission: (_session, permission) => permitted.includes(permission),
  },
});
mock.module(mod("lib/adminApproval.ts"), {
  namedExports: {
    adminApprovalErrorResponse: (error) =>
      error instanceof Reauthentication
        ? Response.json({ error: "Sign in again.", code: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428 })
        : null,
  },
});
mock.module(mod("lib/adminReauthentication.ts"), {
  namedExports: {
    assertRecentAdminAuthentication: async () => {
      if (recentAuthError) throw recentAuthError;
    },
  },
});
const realSecurity = await import(mod("lib/apiSecurity.ts"));
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    ...realSecurity,
    consumeApiRateLimit: async (...args) => {
      rateLimitCalls.push(args);
    },
  },
});
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => [] } });
mock.module(mod("lib/autoRouterOptimizer.ts"), {
  namedExports: {
    promoteAutoRouterOptimizerCycle: async () => ({ ok: true }),
    readAutoRouterOptimizerState: async () => ({ cycles: [] }),
    rollBackAutoRouterGuidance: async () => ({ ok: true }),
    startAutoRouterOptimizerCycle: async () => ({ cycleId: "c" }),
    updateOptimizerAutomation: async () => undefined,
    updateOptimizerModel: async () => undefined,
  },
});
mock.module(mod("lib/autoRouterRecommendations.ts"), {
  namedExports: {
    setRecommendationStatus: async (actor, input) => {
      setCalls.push({ actor, input });
      return setResult;
    },
  },
});

const route = await import(mod("app/api/admin/auto-llm-router/optimizer/route.ts"));

const post = (body) =>
  route.POST(
    new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
const valid = { action: "set_recommendation", cycleId: "cyc_1", index: 2, status: "done" };

test.beforeEach(() => {
  session = { user: { id: "admin-1" } };
  permitted = ["ops:write"];
  recentAuthError = null;
  rateLimitCalls = [];
  setCalls = [];
  setResult = { ok: true, changed: true };
});

test("a visitor who is not an administrator does not learn the action exists", async () => {
  session = null;
  assert.equal((await post(valid)).status, 404);
  assert.equal(setCalls.length, 0);
});

test("an administrator without ops:write is refused before anything is read or written", async () => {
  permitted = [];
  assert.equal((await post(valid)).status, 403);
  assert.equal(setCalls.length, 0);
  assert.equal(rateLimitCalls.length, 0);
});

test("a stale sign-in answers 428 with the code the console turns into a way back", async () => {
  recentAuthError = new Reauthentication();
  const response = await post(valid);
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.equal(setCalls.length, 0);
  assert.equal(rateLimitCalls.length, 0);
});

test("a permitted, recent administrator sets the status through the shared write rate limit", async () => {
  const response = await post(valid);
  assert.equal(response.status, 200);
  assert.deepEqual(setCalls.map((call) => call.input), [valid]);
  assert.equal(setCalls[0].actor.session, session);
  assert.equal(rateLimitCalls[0][2], "admin-auto-router-optimizer-write");
});

test("a status only an agent could set, a negative index or an extra field is refused as invalid", async () => {
  for (const body of [
    { ...valid, status: "claimed" },
    { ...valid, status: "pr_opened" },
    { ...valid, index: -1 },
    { ...valid, index: 1.5 },
    { ...valid, cycleId: "" },
    { ...valid, extra: true },
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(setCalls.length, 0);
});

test("a cycle or recommendation that is gone answers 409 with its code", async () => {
  for (const refused of ["not_found", "no_such_recommendation"]) {
    setResult = { refused };
    const response = await post(valid);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: refused, code: refused });
  }
});
