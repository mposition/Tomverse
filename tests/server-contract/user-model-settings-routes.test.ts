import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for the new-conversation combination
 * (docs/policy/default-model-luna-migration.md §1.2), across
 * /api/user/settings and /api/user/model-finder.
 *
 * What must hold:
 *   - GET /api/user/settings NEVER rewrites the stored row. An unusable
 *     stored defaultModel is answered with an effective replacement plus a
 *     modelSelectionNotice, while the database keeps what the user saved;
 *   - a saved combination and its lead land in the SAME write, and the
 *     response reports only canonical persisted values -- no request echo;
 *   - an explicit combination save is strict: duplicates, unknown models and
 *     plan-locked models are refused, nothing is silently repaired;
 *   - a legacy defaultModel-only save moves the lead inside the existing
 *     combination (order kept, last item dropped on overflow);
 *   - a theme-only save does not touch the model fields at all;
 *   - accept_default keeps its guarded default decision and stores the
 *     combination explicitly as [defaultModelId].
 *
 * Only the session, the rate limiter, the runtime catalogue, the billing
 * plan, the welcome email and Prisma are replaced. The zod schemas, the
 * shared resolver and the routes' own branching are the real ones.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "settings-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type SettingsRow = Record<string, unknown> & {
  userId: string;
  defaultModel: string;
  newConversationModelIds: unknown;
};

type RuntimeModel = Record<string, unknown> & { id: string };

type World = {
  session: { user: { id: string; email?: string } } | null;
  planTier: "Free" | "Pro" | "Max";
  runtimeModels: RuntimeModel[];
  settingsRow: SettingsRow | null;
  creates: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  upserts: Array<Record<string, unknown>>;
};

const { AVAILABLE_MODELS, DEFAULT_MODEL_ID } = require(
  resolve(ROOT, "lib/models.ts")
) as {
  AVAILABLE_MODELS: RuntimeModel[];
  DEFAULT_MODEL_ID: string;
};

const qaProModel: RuntimeModel = {
  ...AVAILABLE_MODELS.find((model) => model.id === DEFAULT_MODEL_ID)!,
  id: "qa-pro-only-model",
  minimumPlan: "Pro",
};

const baseRow = (): SettingsRow => ({
  userId: "user_1",
  theme: "dark",
  language: "en",
  defaultModel: DEFAULT_MODEL_ID,
  newConversationModelIds: null,
  preferredTasks: null,
  preferredPriority: null,
  usesFilesFrequently: null,
  modelFinderCompletedAt: null,
  modelFinderDismissedAt: null,
  timeZone: "UTC",
  timeZoneInitializedAt: new Date("2026-05-01T00:00:00.000Z"),
  timeZoneChangedAt: null,
});

const freshWorld = (): World => ({
  session: { user: { id: "user_1", email: "member@tomverse.app" } },
  planTier: "Free",
  runtimeModels: [...AVAILABLE_MODELS, qaProModel],
  settingsRow: baseRow(),
  creates: [],
  updates: [],
  upserts: [],
});

let world = freshWorld();
let mocksInstalled = false;

async function loadRoutes() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => world.session,
      },
    });

    const realApiSecurity = original("lib/apiSecurity.ts");
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => undefined,
      },
    });

    const realModelRegistry = original("lib/modelRegistry.ts");
    mock.module(mod("lib/modelRegistry.ts"), {
      namedExports: {
        ...realModelRegistry,
        getRuntimeModels: async () => world.runtimeModels,
        isEnabledRuntimeModelId: async (modelId: string) => {
          const model = world.runtimeModels.find((row) => row.id === modelId);
          return Boolean(model && model.enabled && !model.catalogDeleted);
        },
      },
    });

    const realBilling = original("lib/billingEntitlements.ts");
    mock.module(mod("lib/billingEntitlements.ts"), {
      namedExports: {
        ...realBilling,
        getUserBillingPlan: async () => ({ tier: world.planTier }),
      },
    });

    const realDailyUsage = original("lib/userDailyUsage.ts");
    mock.module(mod("lib/userDailyUsage.ts"), {
      namedExports: {
        ...realDailyUsage,
        migrateCurrentDailyUsageBuckets: async () => undefined,
      },
    });

    mock.module(mod("lib/accountEmails.ts"), {
      namedExports: {
        sendAccountWelcomeEmail: async () => undefined,
      },
    });

    const fakePrisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(fakePrisma),
      $executeRaw: async () => 0,
      userSettings: {
        findUnique: async () => world.settingsRow,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          world.creates.push(data);
          world.settingsRow = { ...baseRow(), ...data } as SettingsRow;
          return world.settingsRow;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          world.updates.push(data);
          Object.assign(world.settingsRow ?? {}, data);
          return world.settingsRow;
        },
        upsert: async ({
          update,
          create,
        }: {
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }) => {
          if (world.settingsRow) {
            world.upserts.push(update);
            Object.assign(world.settingsRow, update);
          } else {
            world.upserts.push(create);
            world.settingsRow = { ...baseRow(), ...create } as SettingsRow;
          }
          return world.settingsRow;
        },
      },
      user: {
        findUnique: async () => ({ settings: world.settingsRow }),
      },
    };

    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
  }

  const settings = (await import(
    `${mod("app/api/user/settings/route.ts")}?spy=cached`
  )) as {
    GET: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
  };
  const modelFinder = (await import(
    `${mod("app/api/user/model-finder/route.ts")}?spy=cached`
  )) as {
    POST: (request: Request) => Promise<Response>;
  };
  return { settings, modelFinder };
}

const getRequest = () =>
  new Request("http://127.0.0.1:3100/api/user/settings", { method: "GET" });

const postRequest = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:3100${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const originals = { warn: console.warn, error: console.error };
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.warn = originals.warn;
    console.error = originals.error;
  }
};

test.beforeEach(() => {
  world = freshWorld();
});

// --- GET: the read path reports, it does not rewrite -------------------------

test("GET leaves a healthy row alone and answers [defaultModel] for a null combination", async () => {
  const { settings } = await loadRoutes();
  const response = await settings.GET(getRequest());
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.defaultModelId, DEFAULT_MODEL_ID);
  assert.deepEqual(body.newConversationModelIds, [DEFAULT_MODEL_ID]);
  assert.equal(body.modelSelectionNotice, null);
  assert.equal(world.updates.length, 0);
  assert.equal(world.upserts.length, 0);
});

test("GET with an unusable stored defaultModel answers an effective value and rewrites nothing", async () => {
  const { settings } = await loadRoutes();
  world.settingsRow!.defaultModel = "qa-vanished-model";
  const response = await quiet(() => settings.GET(getRequest()));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.defaultModelId, DEFAULT_MODEL_ID);
  const notice = body.modelSelectionNotice as Record<string, unknown>;
  assert.ok(notice, "the drift must be reported to the caller");
  assert.equal(notice.storedDefaultModelId, "qa-vanished-model");
  // The stored row is untouched: no update, no upsert, value preserved.
  assert.equal(world.updates.length, 0);
  assert.equal(world.upserts.length, 0);
  assert.equal(world.settingsRow!.defaultModel, "qa-vanished-model");
});

test("GET resolves a stored combination and keeps its stored form intact", async () => {
  const { settings } = await loadRoutes();
  world.settingsRow!.newConversationModelIds = [
    "gemini-2-5-flash",
    "qa-vanished-model",
    DEFAULT_MODEL_ID,
  ];
  world.settingsRow!.defaultModel = "gemini-2-5-flash";
  const response = await quiet(() => settings.GET(getRequest()));
  const body = await readJson(response);

  assert.deepEqual(body.newConversationModelIds, [
    "gemini-2-5-flash",
    DEFAULT_MODEL_ID,
  ]);
  assert.ok(body.modelSelectionNotice, "the dropped model must be reported");
  assert.deepEqual(world.settingsRow!.newConversationModelIds, [
    "gemini-2-5-flash",
    "qa-vanished-model",
    DEFAULT_MODEL_ID,
  ]);
  assert.equal(world.updates.length, 0);
});

// --- POST: explicit combination saves ----------------------------------------

test("an explicit combination save writes the lead and the combination together", async () => {
  const { settings } = await loadRoutes();
  const response = await settings.POST(
    postRequest("/api/user/settings", {
      newConversationModelIds: ["gemini-2-5-flash", DEFAULT_MODEL_ID],
    })
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.upserts.length, 1);
  assert.equal(world.upserts[0].defaultModel, "gemini-2-5-flash");
  assert.deepEqual(world.upserts[0].newConversationModelIds, [
    "gemini-2-5-flash",
    DEFAULT_MODEL_ID,
  ]);
  // The response reports what the database now holds.
  const saved = (body.settings as Record<string, unknown>) ?? {};
  assert.deepEqual(saved.newConversationModelIds, [
    "gemini-2-5-flash",
    DEFAULT_MODEL_ID,
  ]);
  assert.equal(saved.defaultModel, "gemini-2-5-flash");
});

test("a defaultModel that is not the combination's first item is a 400", async () => {
  const { settings } = await loadRoutes();
  const response = await settings.POST(
    postRequest("/api/user/settings", {
      defaultModel: DEFAULT_MODEL_ID,
      newConversationModelIds: ["gemini-2-5-flash", DEFAULT_MODEL_ID],
    })
  );

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "DEFAULT_MODEL_LEAD_MISMATCH");
  assert.equal(world.upserts.length, 0);
});

test("duplicates, unknown models and plan-locked models are refused, not repaired", async () => {
  const { settings } = await loadRoutes();

  const duplicate = await settings.POST(
    postRequest("/api/user/settings", {
      newConversationModelIds: [DEFAULT_MODEL_ID, DEFAULT_MODEL_ID],
    })
  );
  assert.equal(duplicate.status, 400);
  assert.equal((await readJson(duplicate)).rejection, "duplicate_model");

  const unknown = await settings.POST(
    postRequest("/api/user/settings", {
      newConversationModelIds: ["qa-vanished-model"],
    })
  );
  assert.equal(unknown.status, 400);
  assert.equal((await readJson(unknown)).rejection, "model_not_selectable");

  const planLocked = await settings.POST(
    postRequest("/api/user/settings", {
      newConversationModelIds: ["qa-pro-only-model"],
    })
  );
  assert.equal(planLocked.status, 400);
  assert.equal((await readJson(planLocked)).rejection, "model_plan_locked");

  const fourModels = await quiet(() =>
    settings.POST(
      postRequest("/api/user/settings", {
        newConversationModelIds: [
          DEFAULT_MODEL_ID,
          "gemini-2-5-flash",
          "claude-haiku-4-5",
          "qa-pro-only-model",
        ],
      })
    )
  );
  assert.equal(fourModels.status, 400);

  assert.equal(world.upserts.length, 0, "nothing may be written");
});

test("the same plan-locked model saves once the plan allows it", async () => {
  const { settings } = await loadRoutes();
  world.planTier = "Pro";
  const response = await settings.POST(
    postRequest("/api/user/settings", {
      newConversationModelIds: ["qa-pro-only-model"],
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(world.upserts[0].newConversationModelIds, [
    "qa-pro-only-model",
  ]);
});

// --- POST: legacy defaultModel-only saves ------------------------------------

test("a legacy defaultModel-only save moves the lead within the stored combination", async () => {
  const { settings } = await loadRoutes();
  world.settingsRow!.newConversationModelIds = [
    DEFAULT_MODEL_ID,
    "gemini-2-5-flash",
  ];
  const response = await settings.POST(
    postRequest("/api/user/settings", { defaultModel: "gemini-2-5-flash" })
  );

  assert.equal(response.status, 200);
  assert.equal(world.upserts[0].defaultModel, "gemini-2-5-flash");
  assert.deepEqual(world.upserts[0].newConversationModelIds, [
    "gemini-2-5-flash",
    DEFAULT_MODEL_ID,
  ]);
});

test("a legacy save into a full combination drops the LAST item", async () => {
  const { settings } = await loadRoutes();
  world.settingsRow!.newConversationModelIds = [
    DEFAULT_MODEL_ID,
    "gemini-2-5-flash",
    "claude-haiku-4-5",
  ];
  await settings.POST(
    postRequest("/api/user/settings", { defaultModel: "claude-sonnet-5" })
  );

  assert.deepEqual(world.upserts[0].newConversationModelIds, [
    "claude-sonnet-5",
    DEFAULT_MODEL_ID,
    "gemini-2-5-flash",
  ]);
});

test("a legacy save with no stored combination persists [defaultModel]", async () => {
  const { settings } = await loadRoutes();
  await settings.POST(
    postRequest("/api/user/settings", { defaultModel: "gemini-2-5-flash" })
  );

  assert.deepEqual(world.upserts[0].newConversationModelIds, [
    "gemini-2-5-flash",
  ]);
});

test("a theme-only save never touches the model fields", async () => {
  const { settings } = await loadRoutes();
  world.settingsRow!.newConversationModelIds = [
    DEFAULT_MODEL_ID,
    "gemini-2-5-flash",
  ];
  const response = await settings.POST(
    postRequest("/api/user/settings", { theme: "light" })
  );

  assert.equal(response.status, 200);
  assert.equal(world.upserts.length, 1);
  assert.ok(!("defaultModel" in world.upserts[0]));
  assert.ok(!("newConversationModelIds" in world.upserts[0]));
});

// --- model finder ------------------------------------------------------------

const FINDER_ANSWERS = { tasks: ["documents"], priority: "fast" };

test("complete persists the combination and the lead together and answers canonically", async () => {
  const { modelFinder } = await loadRoutes();
  const response = await modelFinder.POST(
    postRequest("/api/user/model-finder", {
      action: "complete",
      answers: FINDER_ANSWERS,
      modelIds: [DEFAULT_MODEL_ID, "gemini-2-5-flash"],
    })
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.upserts.length, 1);
  assert.equal(world.upserts[0].defaultModel, DEFAULT_MODEL_ID);
  assert.deepEqual(world.upserts[0].newConversationModelIds, [
    DEFAULT_MODEL_ID,
    "gemini-2-5-flash",
  ]);
  // Canonical response: the persisted values, and no legacy echo field.
  assert.equal(body.defaultModelId, DEFAULT_MODEL_ID);
  assert.deepEqual(body.newConversationModelIds, [
    DEFAULT_MODEL_ID,
    "gemini-2-5-flash",
  ]);
  assert.ok(!("modelIds" in body), "the request array must not be echoed");
  assert.deepEqual(
    body.newConversationModelIds,
    world.settingsRow!.newConversationModelIds,
    "the response must match what the database now holds"
  );
});

test("complete refuses a model outside the recommended combination", async () => {
  const { modelFinder } = await loadRoutes();
  const response = await modelFinder.POST(
    postRequest("/api/user/model-finder", {
      action: "complete",
      answers: FINDER_ANSWERS,
      modelIds: ["qa-pro-only-model"],
    })
  );

  assert.equal(response.status, 400);
  assert.equal(world.upserts.length, 0);
});

test("accept_default keeps the guarded decision and stores [defaultModelId]", async () => {
  const { modelFinder } = await loadRoutes();
  const response = await modelFinder.POST(
    postRequest("/api/user/model-finder", { action: "accept_default" })
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  const savedDefault = world.upserts[0].defaultModel as string;
  assert.equal(savedDefault, body.defaultModelId);
  assert.deepEqual(world.upserts[0].newConversationModelIds, [savedDefault]);
  assert.deepEqual(body.newConversationModelIds, [savedDefault]);
  // The guard stays in the source: the compiled default is never stored
  // without isModelFinderDefaultId approving it.
  const source = require("node:fs").readFileSync(
    resolve(ROOT, "app/api/user/model-finder/route.ts"),
    "utf8"
  ) as string;
  assert.match(
    source,
    /isModelFinderDefaultId\(APP_DEFAULTS\.defaultModelId\)/
  );
});
