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

const world = {
  session: { user: { id: "admin-1" } } as { user: { id: string } } | null,
  admin: true,
  write: true,
  recent: true,
  rows: seed(),
  writes: 0,
  model: { id: "gpt-6-luna" } as { id: string } | null,
  modelAnswer: { proposals: [] } as unknown,
  prompts: [] as string[],
};
const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.admin = true;
  world.write = true;
  world.recent = true;
  world.rows = seed();
  world.writes = 0;
  world.model = { id: "gpt-6-luna" };
  world.modelAnswer = { proposals: [] };
  world.prompts = [];
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
  appSetting: { findMany: async () => [{ key: "feature.assistantProfiles", value: "true" }] },
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
  mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getEnabledRuntimeModel: async () => world.model } });
  mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: (model: unknown) => model } });
  mock.module("ai", {
    namedExports: {
      generateText: async ({ prompt }: { prompt: string }) => {
        world.prompts.push(prompt);
        return { output: world.modelAnswer, usage: { inputTokens: 1, outputTokens: 1 } };
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

test("the console offers the refresh on the app's default model unless it is turned off", async () => {
  reset();
  install();
  const { marketingFeatureRefreshModelId } = await import(mod("lib/marketingFeatureFacts.ts"));
  // On by default (owner decision 2026-11-12).
  assert.equal(marketingFeatureRefreshModelId({}), "gpt-6-luna");
  assert.equal(marketingFeatureRefreshModelId({ MARKETING_FEATURE_REFRESH_LLM_MODEL_ID: "off" }), null);
  assert.equal(marketingFeatureRefreshModelId({ MARKETING_FEATURE_REFRESH_LLM_MODEL_ID: "claude-haiku-5-5" }), "claude-haiku-5-5");
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

test("the refresh proposes from the site and saves nothing", async () => {
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
  assert.equal(result.modelId, "gpt-6-luna");
  assert.equal(world.writes, 0, "a proposal is not a save");
  assert.equal(world.rows[1].hold, "Not live.");
  // It read the FAQ, the help centre, the claims and the switches.
  const prompt = world.prompts[0];
  for (const part of ["public FAQ", "help centre", "marketing claims", "claim.chat-assistants", "feature.assistantProfiles", "IMAGE_EDIT_ENABLED"]) {
    assert.ok(prompt.includes(part), part);
  }
});

test("the refresh is off when its model is turned off or not enabled", async () => {
  reset();
  world.model = null;
  const response = await press();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "FEATURE_REFRESH_OFF");
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
