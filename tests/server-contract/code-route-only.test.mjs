import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The coding API's route-only choice (owner decision 2026-11-28): Smart Adaptive's
// pick and where it runs, with nothing run, reserved or charged. The real handler
// runs here; what would reach the database or a provider is replaced and counted.

const root = resolve(import.meta.dirname, "../..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

// The database: any use is recorded, and none is expected of a choice.
const prismaTouched = [];
const prismaProxy = new Proxy({}, { get: (_target, name) => { prismaTouched.push(String(name)); throw new Error("prisma must not be used: " + String(name)); } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaProxy } });

// The paid router: answers what a test says and records each call.
const routerCalls = [];
let routerPick = null;
mock.module(mod("lib/autoLlmRouter.ts"), {
  namedExports: {
    pickAutoModelWithLlm: async (input) => {
      routerCalls.push(input);
      return routerPick ? { modelId: routerPick, rewrite: null } : null;
    },
  },
});

const runtimeModel = (id, provider, usageClass, extra = {}) => ({
  id, name: id, apiModel: `${provider}-${id}-upstream`, provider, icon: "", bestFor: "", minimumPlan: "Pro", usageClass,
  enabled: true, status: "enabled", inputCapabilities: { image: false, nativePdf: false }, ...extra,
});
const MODELS = [
  runtimeModel("gpt-6-luna", "openai", "standard"),
  runtimeModel("claude-sonnet-x", "anthropic", "premium"),
  runtimeModel("glm-x", "zhipu", "advanced"),
  runtimeModel("deepseek-x", "deepseek", "advanced"),
];
const realRegistry = await import(mod("lib/modelRegistry.ts"));
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { ...realRegistry, getRuntimeModels: async () => MODELS } });

const { externalApiModelCapabilities } = await import(mod("lib/externalApiCatalogCore.ts"));
const { handleCodeRouteOnly } = await import(mod("lib/externalApiRouteOnly.ts"));
const { resetSmartAdaptiveMemory } = await import(mod("lib/externalApiSmartAdaptive.ts"));
const { ExternalApiKeyError } = await import(mod("lib/externalApiKeys.ts"));
const { ApiSecurityError } = await import(mod("lib/apiSecurity.ts"));

const runnableEntries = MODELS.map((model) => ({
  model,
  capabilities: externalApiModelCapabilities(model, { maxInputTokens: 100_000, maxOutputTokens: 8_000, creditWeight: 4 }),
}));

const SWITCHES = ["EXTERNAL_API_ENABLED", "EXTERNAL_API_ROUTE_ONLY_ENABLED", "EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED",
  "EXTERNAL_API_ROUTE_ONLY_PER_MINUTE", "EXTERNAL_API_ROUTE_ONLY_PER_DAY"];
const savedEnv = SWITCHES.map((name) => process.env[name]);
const resetEnv = () => {
  SWITCHES.forEach((name, index) => {
    if (savedEnv[index] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[index];
  });
};

const desktopCaller = { source: "desktop_session", userId: "user-1", keyId: null, keyPrefix: null, creditCap: null, familyId: "family-1" };
const keyCaller = { source: "api_key", userId: "user-1", keyId: "key-1", keyPrefix: "tvk_abcdefgh", creditCap: null };

const calls = { authenticate: 0, account: 0, rateLimit: [], runnable: [], routerAllowed: 0 };
const makeDeps = (overrides = {}) => ({
  authenticate: async () => { calls.authenticate += 1; return overrides.caller ?? desktopCaller; },
  accountAccess: async () => { calls.account += 1; return overrides.account ?? { allowed: true, plan: { tier: "Pro" } }; },
  rateLimit: async (...args) => { calls.rateLimit.push(args); if (overrides.rateLimit) await overrides.rateLimit(); },
  runnable: async (tier, options) => { calls.runnable.push({ tier, options }); return overrides.runnable ?? runnableEntries; },
  ...(overrides.routerAllowed ? { routerAllowed: async (...args) => { calls.routerAllowed += 1; return overrides.routerAllowed(...args); } } : {}),
});

const body = (extra = {}) => ({
  messages: [{ role: "user", content: "Refactor the parser and add tests for the new branch." }],
  ...extra,
});
const post = (payload = body(), headers = {}) =>
  new Request("https://tomverse.app/api/code/v1/route", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "tomverse-desktop/1.0", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const captureLogs = async (run) => {
  const lines = [];
  const info = mock.method(console, "info", (line) => lines.push(String(line)));
  const error = mock.method(console, "error", (line) => lines.push(String(line)));
  try {
    return { result: await run(), lines };
  } finally {
    info.mock.restore();
    error.mock.restore();
  }
};

const reset = () => {
  resetEnv();
  process.env.EXTERNAL_API_ENABLED = "true";
  process.env.EXTERNAL_API_ROUTE_ONLY_ENABLED = "true";
  delete process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED;
  resetSmartAdaptiveMemory();
  routerCalls.length = 0;
  routerPick = null;
  prismaTouched.length = 0;
  calls.authenticate = 0;
  calls.account = 0;
  calls.rateLimit = [];
  calls.runnable = [];
  calls.routerAllowed = 0;
};

test.afterEach(() => reset());
test.after(() => resetEnv());

test("the route is off by default: 503 feature_unavailable before the caller is read", async () => {
  reset();
  delete process.env.EXTERNAL_API_ROUTE_ONLY_ENABLED;
  const response = await handleCodeRouteOnly(post(), makeDeps());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "feature_unavailable");
  assert.equal(calls.authenticate, 0);
  // Only exactly "true" turns it on, and the API itself must be on as well.
  process.env.EXTERNAL_API_ROUTE_ONLY_ENABLED = "1";
  assert.equal((await handleCodeRouteOnly(post(), makeDeps())).status, 503);
  process.env.EXTERNAL_API_ROUTE_ONLY_ENABLED = "true";
  delete process.env.EXTERNAL_API_ENABLED;
  assert.equal((await handleCodeRouteOnly(post(), makeDeps())).status, 503);
  assert.equal(calls.authenticate, 0);
  assert.deepEqual(prismaTouched, []);
});

test("invalid bodies are refused before anything is routed or counted against the router", async () => {
  reset();
  const refused = async (payload, code, status = 400) => {
    const before = routerCalls.length;
    const response = await handleCodeRouteOnly(post(payload), makeDeps());
    assert.equal(response.status, status, JSON.stringify(payload));
    assert.equal((await response.json()).error.code, code, JSON.stringify(payload));
    assert.equal(routerCalls.length, before);
    assert.deepEqual(calls.runnable, [], "no model list is read for a body that is refused");
  };
  await refused("{not json", "invalid_json");
  await refused({}, "invalid_request");
  await refused({ messages: [] }, "invalid_request");
  await refused({ messages: "hello" }, "invalid_request");
  await refused(body({ model: "gpt-6-luna" }), "unsupported_parameter");
  await refused(body({ stream: true }), "unsupported_parameter");
  await refused(body({ localClis: "openai" }), "invalid_request");
  await refused(body({ localClis: ["openai", "not-a-provider"] }), "invalid_request");
  await refused(body({ localClis: ["google"] }), "invalid_request");
  await refused(body({ localClis: ["openai", "openai"] }), "invalid_request");
  await refused(body({ localClis: [...Array(9)].map(() => "openai") }), "invalid_request");
  await refused(body({ localClis: [null] }), "invalid_request");
  await refused({ messages: [{ role: "robot", content: "x" }] }, "invalid_request");
  // The body limit is the route's own, far under a completion request's.
  const oversize = await handleCodeRouteOnly(
    post(body({ messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 1) }] })),
    makeDeps()
  );
  assert.ok(oversize.status === 413 || oversize.status === 400, `oversize body refused (${oversize.status})`);
  assert.deepEqual(prismaTouched, []);
});

test("every accepted provider id parses, an empty or missing list means no local CLI", async () => {
  reset();
  const { ROUTE_ONLY_LOCAL_CLI_PROVIDERS, parseRouteOnlyRequest } = await import(mod("lib/externalApiRouteOnlyCore.ts"));
  assert.deepEqual([...ROUTE_ONLY_LOCAL_CLI_PROVIDERS].sort(), ["anthropic", "minimax", "mistral", "moonshot", "openai", "qwen", "xai", "zhipu"]);
  const all = parseRouteOnlyRequest(JSON.stringify(body({ localClis: [...ROUTE_ONLY_LOCAL_CLI_PROVIDERS] })));
  assert.equal(all.localClis.length, 8);
  assert.deepEqual(parseRouteOnlyRequest(JSON.stringify(body())).localClis, []);
  assert.deepEqual(parseRouteOnlyRequest(JSON.stringify(body({ localClis: [] }))).localClis, []);
});

test("CLI first: a provider in localClis runs on the CLI, any other on the API; the plan decides the pool", async () => {
  reset();
  // The gate is closed here (no router switch): the default model answers.
  const cli = await handleCodeRouteOnly(post(body({ localClis: ["openai", "zhipu"] })), makeDeps());
  assert.equal(cli.status, 200);
  assert.deepEqual(await cli.json(), {
    model: "gpt-6-luna",
    provider: "openai",
    providerModel: "openai-gpt-6-luna-upstream",
    routedBy: "default",
    execution: "cli",
  });
  assert.equal(cli.headers.get("cache-control"), "no-store");
  assert.match(cli.headers.get("x-request-id") ?? "", /^req_[0-9a-f]{32}$/);
  for (const localClis of [undefined, [], ["anthropic", "zhipu"]]) {
    const api = await handleCodeRouteOnly(post(body(localClis ? { localClis } : {})), makeDeps());
    const answer = await api.json();
    assert.equal(answer.provider, "openai");
    assert.equal(answer.execution, "api", JSON.stringify(localClis));
  }
  // The pool is the key's or session's plan, on the coding API's Smart Adaptive list.
  assert.deepEqual(calls.runnable[0], { tier: "Pro", options: { surface: "coding", smartAdaptive: true } });
  assert.deepEqual(prismaTouched, []);
});

test("the router's pick is the choice, for a Desktop session and for a key alike", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = "claude-sonnet-x";
  for (const caller of [desktopCaller, keyCaller]) {
    resetSmartAdaptiveMemory();
    const response = await handleCodeRouteOnly(post(body({ localClis: ["anthropic"] })), makeDeps({ caller, routerAllowed: async () => true }));
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.model, "claude-sonnet-x");
    assert.equal(answer.provider, "anthropic");
    assert.equal(answer.routedBy, "router");
    assert.equal(answer.execution, "cli");
  }
  assert.equal(routerCalls.length, 2);
  // The router reads the task and the candidates, and keeps no conversation row.
  assert.equal(routerCalls[0].conversationId, null);
  assert.equal(routerCalls[0].taskKind, "external_api");
  assert.deepEqual(prismaTouched, []);
});

test("a closed router gate makes no router call and picks by the default rule", async () => {
  reset();
  routerPick = "claude-sonnet-x";
  // The real gate with the router switch off.
  let response = await handleCodeRouteOnly(post(), makeDeps());
  assert.equal((await response.json()).routedBy, "default");
  assert.equal(routerCalls.length, 0);
  // Switch on, but the gate (AI chat paused, key cap spent, recent refusal) says no.
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  resetSmartAdaptiveMemory();
  response = await handleCodeRouteOnly(post(), makeDeps({ routerAllowed: async () => false }));
  const answer = await response.json();
  assert.equal(answer.routedBy, "default");
  assert.equal(answer.model, "gpt-6-luna");
  assert.equal(calls.routerAllowed, 1, "the gate was asked");
  assert.equal(routerCalls.length, 0);
  // The gate gets the caller's own scope and cap: a key by its id, a Desktop session by its account.
  const seen = [];
  resetSmartAdaptiveMemory();
  await handleCodeRouteOnly(post(), makeDeps({ caller: { ...keyCaller, creditCap: 500 }, routerAllowed: async (key) => { seen.push(key); return false; } }));
  resetSmartAdaptiveMemory();
  await handleCodeRouteOnly(post(), makeDeps({ routerAllowed: async (key) => { seen.push(key); return false; } }));
  assert.deepEqual(seen, [{ keyId: "key-1", creditCap: 500 }, { keyId: "desktop-session:user-1", creditCap: null }]);
});

test("a router that gives no answer falls back to the default model", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = null;
  const answer = await (await handleCodeRouteOnly(post(), makeDeps({ routerAllowed: async () => true }))).json();
  assert.equal(routerCalls.length, 1);
  assert.equal(answer.routedBy, "default");
  assert.equal(answer.model, "gpt-6-luna");
});

test("nothing is reserved, charged or receipted: the database is never touched", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = "glm-x";
  const answer = await (await handleCodeRouteOnly(post(body({ localClis: ["zhipu"] })), makeDeps({ routerAllowed: async () => true }))).json();
  assert.equal(answer.execution, "cli");
  assert.deepEqual(prismaTouched, []);
  // And by construction: the handler and its core name no admission, reservation, settlement or receipt.
  for (const file of ["lib/externalApiRouteOnly.ts", "lib/externalApiRouteOnlyCore.ts", "app/api/code/v1/route/route.ts"]) {
    // Code only: the comments say what the route does not do, in those very words.
    const source = readFileSync(resolve(root, file), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
      .join("\n");
    for (const forbidden of ["externalApiAdmission", "acquireChatAccess", "settleChatUsage", "releaseChatAccess", "createChatBudget",
      "reserve", "Reservation", "externalApiRequest", "prisma", "providerFetch", "streamText", "generateText"]) {
      assert.ok(!source.includes(forbidden), `${file} must not reference ${forbidden}`);
    }
  }
});

test("the log has ids, counts and the model, never the request text", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = "claude-sonnet-x";
  const secret = "PRIVATE-TASK-TEXT-9f3a";
  const { result, lines } = await captureLogs(() =>
    handleCodeRouteOnly(
      post(body({ messages: [{ role: "user", content: `${secret} refactor the parser` }], localClis: ["anthropic", "openai"] })),
      makeDeps({ routerAllowed: async () => true })
    )
  );
  assert.equal(result.status, 200);
  assert.ok(lines.every((line) => !line.includes(secret)), "no log line holds the request text");
  const events = lines.map((line) => JSON.parse(line));
  const routeOnly = events.find((event) => event.event === "external_api_route_only");
  assert.ok(routeOnly, "the route-only event is logged");
  assert.deepEqual(Object.keys(routeOnly).sort(), ["event", "execution", "localCliCount", "modelId", "provider", "requestId", "routedBy", "source"]);
  assert.equal(routeOnly.localCliCount, 2);
  assert.equal(routeOnly.modelId, "claude-sonnet-x");
  assert.equal(routeOnly.execution, "cli");
  // Smart Adaptive's own decision line says which protocol asked.
  const decision = events.find((event) => event.event === "external_api_smart_adaptive_routed");
  assert.equal(decision.protocol, "route_only");
});

test("a request rate bucket per account bounds a choice that costs no credits", async () => {
  reset();
  let allowed = 2;
  const deps = makeDeps({
    rateLimit: async () => {
      if (allowed <= 0) throw new ApiSecurityError(429, "RATE_LIMITED", "Too many requests.", 30);
      allowed -= 1;
    },
  });
  assert.equal((await handleCodeRouteOnly(post(), deps)).status, 200);
  assert.equal((await handleCodeRouteOnly(post(), deps)).status, 200);
  const limited = await handleCodeRouteOnly(post(), deps);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  // Its own bucket and defaults, separate from completions' (120 a minute): 30 a minute, 3 000 a day.
  const [, userId, scope, limits] = calls.rateLimit[0];
  assert.equal(userId, "user-1");
  assert.equal(scope, "external-api-route-only");
  assert.deepEqual(limits, { minute: 30, day: 3_000 });
  process.env.EXTERNAL_API_ROUTE_ONLY_PER_MINUTE = "5";
  process.env.EXTERNAL_API_ROUTE_ONLY_PER_DAY = "50";
  await handleCodeRouteOnly(post(), makeDeps());
  assert.deepEqual(calls.rateLimit.at(-1)[3], { minute: 5, day: 50 });
});

test("the rate limit is asked before the body is read or the router is called", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = "claude-sonnet-x";
  const deps = makeDeps({
    routerAllowed: async () => true,
    rateLimit: async () => { throw new ApiSecurityError(429, "RATE_LIMITED", "Too many requests.", 10); },
  });
  const response = await handleCodeRouteOnly(post(), deps);
  assert.equal(response.status, 429);
  assert.equal(routerCalls.length, 0);
  assert.deepEqual(calls.runnable, []);
});

test("an unauthenticated or ineligible caller is refused before any routing", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  const refusedAuth = await handleCodeRouteOnly(post(), {
    ...makeDeps({ routerAllowed: async () => true }),
    authenticate: async () => { throw new ExternalApiKeyError(401, "invalid_api_key", "Invalid API key."); },
  });
  assert.equal(refusedAuth.status, 401);
  const refusedPlan = await handleCodeRouteOnly(post(), makeDeps({
    account: { allowed: false, code: "plan_not_eligible", message: "The Tomverse API needs a Pro or Max plan." },
    routerAllowed: async () => true,
  }));
  assert.equal(refusedPlan.status, 403);
  assert.equal((await refusedPlan.json()).error.code, "plan_not_eligible");
  assert.equal(routerCalls.length, 0);
  assert.deepEqual(calls.rateLimit, [], "not even counted");
});

test("with no model Smart Adaptive may default to, the choice is a 404, not a guess", async () => {
  reset();
  const response = await handleCodeRouteOnly(post(), makeDeps({ runnable: [] }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_not_found");
});

test("a tool round is never routed: the choice is made once, for a new task", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = "claude-sonnet-x";
  const response = await handleCodeRouteOnly(
    post({
      messages: [
        { role: "user", content: "Fix the failing test." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "run_tests", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "1 failing" },
      ],
      localClis: ["zhipu"],
    }),
    makeDeps({ routerAllowed: async () => true })
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_request");
  assert.equal(routerCalls.length, 0);
});

test("a pick that cannot take the request is not recommended", async () => {
  reset();
  // No model here reads images, so an image task has no fitting model: the answer says so instead of naming the default.
  const response = await handleCodeRouteOnly(
    post({ messages: [{ role: "user", content: [{ type: "text", text: "What does this screenshot show?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }] }),
    makeDeps()
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unsupported_request");
});

test("a choice writes no conversation memory: a later choice for the same task is free to go to a cheaper model", async () => {
  reset();
  process.env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED = "true";
  routerPick = "claude-sonnet-x";
  const first = await (await handleCodeRouteOnly(post(), makeDeps({ routerAllowed: async () => true }))).json();
  assert.equal(first.model, "claude-sonnet-x");
  routerPick = "gpt-6-luna";
  const second = await (await handleCodeRouteOnly(post(), makeDeps({ routerAllowed: async () => true }))).json();
  assert.equal(second.model, "gpt-6-luna");
  assert.equal(second.routedBy, "router");
});
