import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * The ad facts routes (owner request 2026-11-12):
 * - /api/admin/marketing/feature-facts adds or changes an entry only
 *   through runMarketingAdminMutation (captured here;
 *   its permission, step-up and audit transaction are swept for every
 *   marketing route in tests/marketingS2b1Store.test.mjs);
 * - /api/admin/marketing-feature-refresh asks one model call for
 *   proposals and writes nothing;
 * - /api/internal/marketing-features gives the box's job the list under the
 *   media secret.
 * The real lib runs against an in-memory table; the model call is a fake.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type Row = {
  id: string;
  position: number;
  what: string;
  models: string[];
  realExample: unknown;
  copy: string | null;
  disclosure: unknown;
  source: string;
  hold: string | null;
  updatedAt: Date;
};

const seed = (): Row[] => [
  { id: "chat", position: 0, what: "Chat.", models: ["GPT 6 Luna"], realExample: null, copy: null, disclosure: null, source: "claim.chat-and-review", hold: null, updatedAt: new Date("2026-11-12T00:00:00.000Z") },
  { id: "plugins", position: 1, what: "Plugins.", models: [], realExample: null, copy: null, disclosure: null, source: "/plugins", hold: "Not live.", updatedAt: new Date("2026-11-12T00:00:00.000Z") },
];

/** A valid marketing price pin (as tests/marketingLlmClientCore.test.mjs writes one). */
const PIN = {
  model: "gpt-6-luna-api",
  tokenizerFamily: "o200k",
  projectId: "key-scoped",
  region: "us",
  tiers: ["default"],
  contextWindowTokens: 128_000,
  worstInputMicroUsdPerMillion: 800_000,
  worstOutputMicroUsdPerMillion: 3_200_000,
  maxOutputTokens: 4_096,
  priceVersion: "fixture-v1",
  verifiedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2099-12-30T00:00:00.000Z",
  source: "https://example.invalid/pricing",
};

const world = {
  session: { user: { id: "admin-1" } } as { user: { id: string } } | null,
  admin: true,
  write: true,
  recent: true,
  rows: seed(),
  writes: 0,
  /** The marketing LLM model the operator chose (marketing.llmSettings). */
  settingsModel: PIN.model as string | null,
  modelAnswer: { proposals: [] } as unknown,
  prompts: [] as string[],
  maxOutputTokens: [] as number[],
  /** Each budget action the refresh sent, with its fields. */
  budget: [] as Array<{ action: string; fields: Record<string, unknown> }>,
  reserveRefusal: null as string | null,
};
const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.admin = true;
  world.write = true;
  world.recent = true;
  world.rows = seed();
  world.writes = 0;
  world.settingsModel = PIN.model;
  world.modelAnswer = { proposals: [] };
  world.prompts = [];
  world.maxOutputTokens = [];
  world.budget = [];
  world.reserveRefusal = null;
};

const pick = (row: Row) => ({ ...row });
const table = {
  findMany: async () => [...world.rows].sort((a, b) => a.position - b.position).map(pick),
  findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
    const row = world.rows.find((entry) => entry.id === where.id);
    if (!row) return null;
    return select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Row]])) : pick(row);
  },
  findUniqueOrThrow: async ({ where }: { where: { id: string } }) => pick(world.rows.find((entry) => entry.id === where.id)!),
  aggregate: async () => ({ _max: { position: Math.max(-1, ...world.rows.map((row) => row.position)) } }),
  create: async ({ data }: { data: Omit<Row, "updatedAt" | "realExample" | "disclosure"> }) => {
    world.writes += 1;
    const row: Row = { realExample: null, disclosure: null, ...data, updatedAt: new Date("2026-11-12T01:00:00.000Z") };
    world.rows.push(row);
    return pick(row);
  },
  updateMany: async ({ where, data }: { where: { id: string; updatedAt: Date }; data: Partial<Row> }) => {
    const row = world.rows.find((entry) => entry.id === where.id && entry.updatedAt.getTime() === where.updatedAt.getTime());
    if (!row) return { count: 0 };
    world.writes += 1;
    Object.assign(row, data, { updatedAt: new Date("2026-11-12T02:00:00.000Z") });
    return { count: 1 };
  },
};
const prisma = {
  marketingFeatureFact: table,
  appSetting: {
    findMany: async () => [{ key: "feature.assistantProfiles", value: "true" }],
    findUnique: async ({ where }: { where: { key: string } }) =>
      where.key === "marketing.llmSettings" ? { value: JSON.stringify({ model: world.settingsModel, monthlyUsdCap: "20" }) } : null,
  },
};

class StepUpRequired extends Error {}
type Spec = {
  action: string;
  targetType: string;
  targetId: (body: unknown) => string;
  gate: string;
  schema: { safeParse: (body: unknown) => { success: boolean; data?: unknown } };
  metadata: (body: unknown, tx: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
  refusal: (error: unknown) => { code: string; status: number } | null;
  run: (tx: unknown, context: unknown) => Promise<Row>;
};
const specs = new Map<string, Spec>();

let installed = false;
const install = () => {
  if (installed) return;
  installed = true;
  mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
  mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
  mock.module(mod("lib/adminAuth.ts"), {
    namedExports: { isAdminSession: () => world.admin, hasAdminPermission: () => world.write },
  });
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: { consumeApiRateLimit: async () => undefined, apiSecurityResponse: () => null },
  });
  mock.module(mod("lib/adminReauthentication.ts"), {
    namedExports: {
      assertRecentAdminAuthentication: async () => {
        if (!world.recent) throw new StepUpRequired();
      },
    },
  });
  mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeAdminAuditLog: async () => undefined } });
  mock.module(mod("lib/adminApproval.ts"), {
    namedExports: {
      adminApprovalErrorResponse: (error: unknown) =>
        error instanceof StepUpRequired ? Response.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428 }) : null,
    },
  });
  mock.module(mod("lib/marketingAdminMutations.ts"), {
    namedExports: {
      runMarketingAdminMutation: async (spec: Spec & { bucket: string }) => {
        specs.set(spec.bucket, spec);
        return new Response(null, { status: 204 });
      },
    },
  });
  mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
  mock.module(mod("lib/modelRegistry.ts"), {
    namedExports: { getRuntimeModels: async () => [{ id: "gpt-6-luna", enabled: true, provider: "openai", apiModel: PIN.model }] },
  });
  mock.module(mod("lib/marketingLlmModelCatalog.ts"), { namedExports: { marketingLlmCatalogPins: async () => [PIN] } });
  // The ledger's own actions are tested with the store in
  // tests/server-contract/marketing-llm-budget-in-process-port.test.ts; here
  // the port records what the refresh sent and answers as the ledger would.
  mock.module(mod("lib/marketingLlmBudgetRequest.ts"), {
    namedExports: {
      marketingLlmBudgetInProcessPort: (_prisma: unknown, budget: { killSwitchOn: boolean }) =>
        async (action: string, fields: Record<string, unknown>) => {
          world.budget.push({ action, fields });
          if (action === "reserve") {
            if (budget.killSwitchOn) return { httpStatus: 200, body: { status: "refused", code: "kill_switch" } };
            if (world.reserveRefusal) return { httpStatus: 200, body: { status: "refused", code: world.reserveRefusal } };
            return { httpStatus: 200, body: { status: "ok", callId: "c1", reservedMicroUsd: 1000 } };
          }
          if (action === "dispatch") return { httpStatus: 200, body: { status: "ok", firstConsumption: true } };
          if (action === "settle") return { httpStatus: 200, body: { status: "ok", state: "settled" } };
          return { httpStatus: 200, body: { status: "ok" } };
        },
    },
  });
  mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: (model: unknown) => model } });
  mock.module("ai", {
    namedExports: {
      generateText: async ({ prompt, maxOutputTokens }: { prompt: string; maxOutputTokens: number }) => {
        world.prompts.push(prompt);
        world.maxOutputTokens.push(maxOutputTokens);
        return { output: world.modelAnswer, usage: { inputTokens: 1200, outputTokens: 300 } };
      },
      jsonSchema: (schema: unknown) => schema,
      Output: { object: (value: unknown) => value },
    },
  });
};

const listRoute = async () => {
  install();
  return import(mod("app/api/admin/marketing/feature-facts/route.ts"));
};
const spec = async (bucket: string, method: "POST" | "PATCH") => {
  const route = await listRoute();
  await route[method](new Request("https://tomverse.test/api/admin/marketing/feature-facts", { method }));
  return specs.get(bucket)!;
};

test("the refresh is on unless turned off, on the marketing model the operator chose", async () => {
  reset();
  install();
  const { marketingFeatureRefreshModel, marketingFeatureRefreshOn } = await import(mod("lib/marketingFeatureFacts.ts"));
  // On by default (owner decision 2026-11-12).
  assert.equal(marketingFeatureRefreshOn({}), true);
  assert.equal(marketingFeatureRefreshOn({ MARKETING_FEATURE_REFRESH: "off" }), false);
  assert.equal(await marketingFeatureRefreshModel(prisma, {}), PIN.model);
  assert.equal(await marketingFeatureRefreshModel(prisma, { MARKETING_FEATURE_REFRESH: "off" }), null);
  world.settingsModel = null;
  assert.equal(await marketingFeatureRefreshModel(prisma, {}), null);
});

test("a change is the audited mutation of the row the screen saw, and a stale screen is refused", async () => {
  reset();
  const patch = await spec("admin-marketing-feature-fact-update", "PATCH");
  assert.equal(patch.action, "marketing_feature_fact.update");
  assert.equal(patch.targetType, "MarketingFeatureFact");
  // A hold during an incident is a stop: no switch refuses it.
  assert.equal(patch.gate, "operator_restriction");
  const body = { id: "plugins", what: "Plugins.", models: [], copy: "", source: "/plugins", hold: "", expectedUpdatedAt: "2026-11-12T00:00:00.000Z" };
  const parsed = patch.schema.safeParse(body).data;
  assert.equal(patch.schema.safeParse({ ...body, disclosure: { en: "x" } }).success, false);
  assert.deepEqual(await patch.metadata(parsed, prisma), {
    id: "plugins",
    before: { what: "Plugins.", models: [], copy: null, source: "/plugins", hold: "Not live." },
    after: { what: "Plugins.", models: [], copy: null, source: "/plugins", hold: null },
  });
  const saved = await patch.run(prisma, { body: parsed, session: { user: { id: "admin-1" } } });
  assert.equal(saved.hold, null, "the hold is released");

  // The same request again names a row that has moved on.
  const { MarketingFeatureFactRefusedError } = await import(mod("lib/marketingFeatureFactsCore.ts"));
  await assert.rejects(patch.run(prisma, { body: parsed, session: { user: { id: "admin-1" } } }), (error: unknown) => {
    assert.ok(error instanceof MarketingFeatureFactRefusedError);
    assert.deepEqual(patch.refusal(error), { code: "feature_fact_conflict", status: 409, message: (error as Error).message });
    return true;
  });
});

test("an addition goes last, and an id that exists is refused", async () => {
  reset();
  const post = await spec("admin-marketing-feature-fact-create", "POST");
  assert.equal(post.action, "marketing_feature_fact.create");
  const body = post.schema.safeParse({ id: "voice-input", what: "Speak.", models: [], copy: null, source: "locales", hold: "Not live." }).data;
  const saved = await post.run(prisma, { body, session: { user: { id: "admin-1" } } });
  assert.equal(saved.position, 2);
  await assert.rejects(post.run(prisma, { body, session: { user: { id: "admin-1" } } }), /already exists/u);
});

const refreshRoute = async () => {
  install();
  return import(mod("app/api/admin/marketing-feature-refresh/route.ts"));
};
const press = async () => (await refreshRoute()).POST(new Request("https://tomverse.test/api/admin/marketing-feature-refresh", { method: "POST" }));

test("the refresh needs marketing write and a recent sign-in", async () => {
  reset();
  world.write = false;
  assert.equal((await press()).status, 403);
  world.write = true;
  world.recent = false;
  assert.equal((await press()).status, 428);
  assert.equal(world.prompts.length, 0, "no model call before the checks pass");
});

test("the refresh reserves, calls once and settles in the marketing ledger, proposes from the site and saves nothing", async () => {
  reset();
  world.modelAnswer = {
    proposals: [
      { kind: "release_hold", id: "plugins", what: "Plugins.", models: [], copy: null, source: "/plugins", hold: null, reason: "Live now." },
      { kind: "add", id: "chat", what: "Dup.", models: [], copy: null, source: "x", hold: null, reason: "Dup." },
    ],
  };
  const response = await press();
  assert.equal(response.status, 200);
  const { result } = await response.json();
  assert.deepEqual(result.proposals.map((p: { id: string }) => p.id), ["plugins"]);
  assert.equal(result.dropped, 1);
  assert.equal(result.modelId, PIN.model);
  assert.equal(world.writes, 0, "a proposal is not a save");
  // The cost ledger: reserved under its own purpose before the call, settled after with the reported tokens.
  assert.deepEqual(world.budget.map((entry) => entry.action), ["reserve", "dispatch", "settle"]);
  assert.equal(world.budget[0].fields.purpose, "feature_refresh");
  assert.equal(world.budget[0].fields.model, PIN.model);
  assert.equal(world.budget[2].fields.reportedInputTokens, 1200);
  assert.equal(world.budget[2].fields.reportedOutputTokens, 300);
  assert.deepEqual(world.maxOutputTokens, [PIN.maxOutputTokens], "the output cap the reservation priced");
  assert.equal(world.rows[1].hold, "Not live.");
  // It read the FAQ, the help centre, the claims and the switches.
  const prompt = world.prompts[0];
  for (const part of ["public FAQ", "help centre", "marketing claims", "claim.chat-assistants", "feature.assistantProfiles", "IMAGE_EDIT_ENABLED"]) {
    assert.ok(prompt.includes(part), part);
  }
});

test("a refusal by the ledger or a missing model sends nothing", async () => {
  reset();
  world.reserveRefusal = "budget_exhausted";
  let response = await press();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "The cost ledger refused the call (budget_exhausted).",
    code: "FEATURE_REFRESH_REFUSED",
    reason: "budget_exhausted",
  });
  assert.equal(world.prompts.length, 0, "no model call past a refused reservation");

  reset();
  world.settingsModel = null;
  response = await press();
  assert.equal((await response.json()).reason, "model_not_selected");
  assert.equal(world.budget.length, 0);

  reset();
  const saved = process.env.MARKETING_FEATURE_REFRESH;
  process.env.MARKETING_FEATURE_REFRESH = "off";
  try {
    response = await press();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "FEATURE_REFRESH_OFF");
  } finally {
    if (saved === undefined) delete process.env.MARKETING_FEATURE_REFRESH;
    else process.env.MARKETING_FEATURE_REFRESH = saved;
  }
});

test("the kill switch stops the refresh before any model call", async () => {
  reset();
  const saved = process.env.MARKETING_AUTOMATION_KILL_SWITCH;
  process.env.MARKETING_AUTOMATION_KILL_SWITCH = "on";
  try {
    const response = await press();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MARKETING_KILL_SWITCH");
    assert.equal(world.prompts.length, 0);
  } finally {
    if (saved === undefined) delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
    else process.env.MARKETING_AUTOMATION_KILL_SWITCH = saved;
  }
});

test("the box reads the list under the media secret, never under the kill switch", async () => {
  reset();
  install();
  const { GET } = await import(mod("app/api/internal/marketing-features/route.ts"));
  const secret = "m".repeat(40);
  const ask = (token?: string) =>
    GET(new Request("https://tomverse.test/api/internal/marketing-features", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const saved = { secret: process.env.MARKETING_MEDIA_SUBMIT_SECRET, kill: process.env.MARKETING_AUTOMATION_KILL_SWITCH };
  process.env.MARKETING_MEDIA_SUBMIT_SECRET = secret;
  delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
  try {
    assert.equal((await ask()).status, 401);
    assert.equal((await ask("wrong".repeat(10))).status, 401);
    const response = await ask(secret);
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(typeof result.note, "string");
    assert.deepEqual(result.features, [
      { id: "chat", what: "Chat.", models: ["GPT 6 Luna"], source: "claim.chat-and-review" },
      { id: "plugins", what: "Plugins.", source: "/plugins", hold: "Not live." },
    ]);
    process.env.MARKETING_AUTOMATION_KILL_SWITCH = "on";
    assert.equal((await ask(secret)).status, 503);
  } finally {
    if (saved.secret === undefined) delete process.env.MARKETING_MEDIA_SUBMIT_SECRET;
    else process.env.MARKETING_MEDIA_SUBMIT_SECRET = saved.secret;
    if (saved.kill === undefined) delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
    else process.env.MARKETING_AUTOMATION_KILL_SWITCH = saved.kill;
  }
});
