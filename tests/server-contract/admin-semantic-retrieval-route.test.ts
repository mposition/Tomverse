import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Admin › Feature flags: the semantic retrieval switches. Reading is open to any
// administrator; a change needs `ops:write` and a recent step-up. Only a switch
// whose value changes is written, a switch cannot be turned on before its
// environment is complete, and the provider key never appears in a response.
// The settings store is faked; its audit behaviour is the store's own.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

const SECRET_KEY = "cohere-secret-key-value-1234567890";

type Switches = Record<string, boolean>;
type World = {
  session: { user: { id: string; authenticatedAt?: string } } | null;
  admin: boolean;
  opsWrite: boolean;
  switches: Switches;
  updates: Array<{ feature: string; on: boolean }>;
  /** How many times the store was asked to write; one per request at most. */
  updateCalls: number;
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "operator-1", authenticatedAt: new Date().toISOString() } },
    admin: true,
    opsWrite: true,
    switches: {
      knowledgeRerank: false,
      knowledgeEmbed: false,
      knowledgeImagePages: false,
      memoryRerank: false,
      memoryDuplicates: false,
    },
    updates: [],
    updateCalls: 0,
    ...changes,
  };
};
reset();

const ENV_NAMES = [
  "SEMANTIC_RETRIEVAL_TEST_NOTICE",
  "COHERE_API_KEY",
  "COHERE_RERANK_MODEL",
  "COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT",
  "COHERE_RERANK_MICROUSD_PER_MILLION_TOKENS",
  "COHERE_EMBED_MODEL",
  "COHERE_EMBED_DIMENSION",
  "COHERE_EMBED_MICROUSD_PER_MILLION_TEXT_TOKENS",
  "COHERE_EMBED_MICROUSD_PER_MILLION_IMAGE_TOKENS",
  "RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY",
  "RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH",
];
/** Rerank is fully configured; embeddings are not. */
// The published-notice stand-in is read only in a test process.
Object.assign(process.env, { NODE_ENV: "test" });

const rerankOnlyEnv = () => {
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.SEMANTIC_RETRIEVAL_TEST_NOTICE = "published";
  process.env.COHERE_API_KEY = SECRET_KEY;
  process.env.COHERE_RERANK_MODEL = "rerank-v3.5";
  process.env.COHERE_RERANK_MICROUSD_PER_SEARCH_UNIT = "2000";
  process.env.RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_DAY = "1000000";
  process.env.RETRIEVAL_PROVIDER_COHERE_COST_MICROUSD_PER_MONTH = "10000000";
};
const emptyEnv = () => {
  for (const name of ENV_NAMES) delete process.env[name];
};

type Route = {
  GET: (request: Request) => Promise<Response>;
  PUT: (request: Request) => Promise<Response>;
};

let installed = false;
async function loadRoute(): Promise<Route> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.admin,
        hasAdminPermission: (_session: unknown, permission: string) =>
          permission === "ops:write" && world.opsWrite,
      },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/semanticRetrievalSettings.ts"), {
      namedExports: {
        readSemanticRetrievalSwitches: async () => ({ ...world.switches }),
        // One call carries every change of a request, so they commit together.
        updateSemanticRetrievalSwitches: async (
          _actor: unknown,
          changes: Record<string, boolean>
        ) => {
          world.updateCalls += 1;
          for (const [feature, on] of Object.entries(changes)) {
            world.updates.push({ feature, on });
            world.switches[feature] = on;
          }
          return Object.keys(changes);
        },
      },
    });
  }
  return import(mod("app/api/admin/semantic-retrieval/route.ts"));
}

const URL_ = "https://tomverse.app/api/admin/semantic-retrieval";
const get = () => new Request(URL_);
const put = (body: unknown) =>
  new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("only an administrator can read the switches; everyone else is told 404", async () => {
  const { GET } = await loadRoute();
  rerankOnlyEnv();

  reset({ session: null });
  assert.equal((await GET(get())).status, 404);
  reset({ admin: false });
  assert.equal((await GET(get())).status, 404);

  // Reading needs no write permission.
  reset({ opsWrite: false });
  const read = await GET(get());
  assert.equal(read.status, 200);
});

test("the read reports each switch and what is configured, without the key", async () => {
  const { GET } = await loadRoute();
  rerankOnlyEnv();
  process.env.COHERE_EMBED_DIMENSION = "not-a-number";
  reset({ switches: { ...world.switches, knowledgeRerank: true } });

  const response = await GET(get());
  const text = await response.text();
  assert.equal(text.includes(SECRET_KEY), false, "the key value must not be in the response");

  const body = JSON.parse(text);
  assert.deepEqual(body.features, {
    knowledgeRerank: { on: true, configured: true },
    knowledgeEmbed: { on: false, configured: false },
    knowledgeImagePages: { on: false, configured: false },
    memoryRerank: { on: false, configured: true },
    memoryDuplicates: { on: false, configured: false },
  });
  assert.equal(body.keyConfigured, true);
  assert.equal(body.budgetConfigured, true);
  assert.deepEqual(body.problems, ["COHERE_EMBED_DIMENSION"]);
});

test("without the key nothing is configured, and every switch reads off by default", async () => {
  const { GET } = await loadRoute();
  rerankOnlyEnv();
  delete process.env.COHERE_API_KEY;
  reset();

  const body = await (await GET(get())).json();
  assert.equal(body.keyConfigured, false);
  for (const state of Object.values(body.features) as Array<{ on: boolean; configured: boolean }>) {
    assert.deepEqual(state, { on: false, configured: false });
  }

  emptyEnv();
  const bare = await (await GET(get())).json();
  assert.equal(bare.budgetConfigured, false);
});

test("a change needs an administrator with ops:write and a recent step-up", async () => {
  const { PUT } = await loadRoute();
  rerankOnlyEnv();

  reset({ session: null });
  assert.equal((await PUT(put({ knowledgeRerank: true }))).status, 404);
  reset({ admin: false });
  assert.equal((await PUT(put({ knowledgeRerank: true }))).status, 404);
  reset({ opsWrite: false });
  assert.equal((await PUT(put({ knowledgeRerank: true }))).status, 403);
  assert.deepEqual(world.updates, []);

  reset({
    session: {
      user: {
        id: "operator-1",
        authenticatedAt: new Date(Date.now() - 9 * 60 * 60_000).toISOString(),
      },
    },
  });
  const stale = await PUT(put({ knowledgeRerank: true }));
  assert.equal(stale.status, 428);
  assert.equal((await stale.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.deepEqual(world.updates, []);
});

test("only a switch whose value changes is written", async () => {
  const { PUT } = await loadRoute();
  rerankOnlyEnv();
  reset({ switches: { ...world.switches, knowledgeRerank: true, memoryDuplicates: true } });

  // knowledgeRerank is unchanged; memoryRerank turns on; memoryDuplicates turns off.
  const response = await PUT(
    put({ knowledgeRerank: true, memoryRerank: true, memoryDuplicates: false })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(world.updates, [
    { feature: "memoryRerank", on: true },
    { feature: "memoryDuplicates", on: false },
  ]);
  // Both changes went to the store in one call, so they commit together.
  assert.equal(world.updateCalls, 1);
  const body = await response.json();
  assert.equal(body.features.memoryRerank.on, true);
  assert.equal(body.features.memoryDuplicates.on, false);
  assert.equal(JSON.stringify(body).includes(SECRET_KEY), false);

  // An empty body changes nothing.
  reset();
  assert.equal((await PUT(put({}))).status, 200);
  assert.deepEqual(world.updates, []);
  assert.equal(world.updateCalls, 0);
});

test("a switch cannot be turned on before its environment is set, but can always be turned off", async () => {
  const { PUT } = await loadRoute();
  rerankOnlyEnv();

  // Embeddings have no model or price here.
  reset();
  const refused = await PUT(put({ knowledgeRerank: true, knowledgeEmbed: true }));
  assert.equal(refused.status, 409);
  assert.deepEqual(world.updates, [], "a refused request writes nothing, not even its valid part");

  // A switch left on after its environment went away can still be turned off.
  emptyEnv();
  reset({ switches: { ...world.switches, knowledgeEmbed: true } });
  const off = await PUT(put({ knowledgeEmbed: false }));
  assert.equal(off.status, 200);
  assert.deepEqual(world.updates, [{ feature: "knowledgeEmbed", on: false }]);
});

test("a body outside the strict shape never reaches the store", async () => {
  const { PUT } = await loadRoute();
  rerankOnlyEnv();

  for (const body of [
    { knowledgeRerank: "yes" },
    { unknownFeature: true },
    { knowledgeRerank: true, extra: 1 },
    [true],
    "not json",
  ]) {
    reset();
    const answer = await PUT(put(body));
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(world.updates, [], JSON.stringify(body));
  }
});

test("before the privacy notice is published nothing reads as configured and nothing turns on", async () => {
  const { GET, PUT } = await loadRoute();
  rerankOnlyEnv();
  delete process.env.SEMANTIC_RETRIEVAL_TEST_NOTICE;
  reset();

  const body = await (await GET(get())).json();
  assert.equal(body.privacyNoticePublished, false);
  for (const state of Object.values(body.features) as Array<{ configured: boolean }>) {
    assert.equal(state.configured, false);
  }
  assert.equal((await PUT(put({ knowledgeRerank: true }))).status, 409);
  assert.deepEqual(world.updates, []);

  // Turning a switch off stays possible: an operator can always stop the calls.
  reset({ switches: { ...world.switches, memoryRerank: true } });
  assert.equal((await PUT(put({ memoryRerank: false }))).status, 200);
  assert.deepEqual(world.updates, [{ feature: "memoryRerank", on: false }]);
});
