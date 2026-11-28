import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * Server-side contract for `POST /api/chat/readout`
 * (docs/policy/voice-input.md §6.4).
 *
 * Mostly about what the endpoint refuses and what a refusal must not have
 * done: reached the provider, or spent the budget. Only the session, the rate
 * limiter, the database, the price register, the key and the provider are
 * replaced; the budget composition, the text pieces and the provider-outcome
 * classification are the real ones, over an in-memory bucket store.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "chat-readout-contract-secret";

const ON_ENV = {
  CHAT_SERVER_READOUT_ENABLED: "true",
  CHAT_READOUT_CHARACTERS_PER_ACCOUNT_DAY: "5000",
  CHAT_READOUT_PROVIDER_CHARACTERS_PER_DAY: "50000",
  CHAT_READOUT_PROVIDER_CHARACTERS_PER_MONTH: "500000",
};

type Message = {
  id: string;
  role: string;
  status: string;
  content: string;
  conversationId: string;
  conversation: { userId: string; kind: string; password: string | null; passwordVersion: number };
};

type World = {
  userId: string | null;
  unlocked: boolean;
  apiKey: string | null;
  priceRefusal: { code: string; detail: string } | null;
  message: Message | null;
  rateLimitScopes: string[];
  rows: Map<string, number>;
  providerCalls: Array<{ url: string; body: Record<string, unknown> }>;
  provider: () => Response;
};

const ANSWER = "Here is the answer you asked for.\n\n```js\nconst hidden = 1;\n```\n\nThat is all.";

const freshWorld = (): World => ({
  userId: "user_readout",
  unlocked: true,
  apiKey: "sk-test-readout",
  priceRefusal: null,
  message: {
    id: "msg_1",
    role: "assistant",
    status: "normal",
    content: ANSWER,
    conversationId: "conv_1",
    conversation: { userId: "user_readout", kind: "chat", password: null, passwordVersion: 0 },
  },
  rateLimitScopes: [],
  rows: new Map(),
  providerCalls: [],
  provider: () => new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
});

let world = freshWorld();
let mocksInstalled = false;
const realFetch = globalThis.fetch;

const booked = () => [...world.rows.values()].reduce((sum, value) => sum + value, 0);

async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("lib/chatRouteSession.ts"), {
      namedExports: {
        resolveChatRouteSession: async () => ({ session: world.userId ? { user: { id: world.userId } } : null }),
      },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        consumeApiRateLimit: async (_request: unknown, _userId: string, scope: string) => {
          world.rateLimitScopes.push(scope);
        },
        readLimitedJson: async (request: Request, _max: number, schema: { parse: (value: unknown) => unknown }) =>
          schema.parse(await request.json()),
        apiSecurityResponse: () => null,
      },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          message: {
            findUnique: async ({ where }: { where: { id: string } }) =>
              world.message && world.message.id === where.id ? world.message : null,
          },
        },
      },
    });
    mock.module(mod("lib/conversationLock.ts"), {
      namedExports: {
        hasConversationUnlockGrant: () => world.unlocked,
        conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
      },
    });
    mock.module(mod("lib/chatReadoutPricing.ts"), {
      namedExports: { readoutModelPriceRefusal: () => world.priceRefusal },
    });
    mock.module(mod("lib/chatReadoutServer.ts"), {
      namedExports: { readoutApiKey: () => world.apiKey },
    });
    const id = (booking: { key: string; period: string; periodStart: Date }) =>
      `${booking.key}|${booking.period}|${booking.periodStart.toISOString()}`;
    mock.module(mod("lib/chatReadoutBudget.ts"), {
      namedExports: {
        readoutAccountKey: (userId: string) => `account:${userId}`,
        readoutProviderKey: () => "provider",
        readoutBudgetStore: {
          async book(booking: { key: string; period: string; periodStart: Date; characters: number; limit: number }) {
            const current = world.rows.get(id(booking));
            if (current !== undefined && current > booking.limit - booking.characters) return false;
            world.rows.set(id(booking), (current ?? 0) + booking.characters);
            return true;
          },
          async unbook(booking: { key: string; period: string; periodStart: Date; characters: number }) {
            world.rows.set(id(booking), Math.max(0, (world.rows.get(id(booking)) ?? 0) - booking.characters));
          },
        },
      },
    });
  }
  return (await import(mod("app/api/chat/readout/route.ts"))) as { POST: (request: Request) => Promise<Response> };
}

const request = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/chat/readout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const withEnv = async (env: Record<string, string | undefined>, run: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  const keys = new Set([...Object.keys(ON_ENV), "CHAT_SERVER_READOUT_KILL_SWITCH", ...Object.keys(env)]);
  for (const key of keys) saved[key] = process.env[key];
  for (const key of keys) {
    const value = key in env ? env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    world.providerCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return world.provider();
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const scenario = (name: string, env: Record<string, string | undefined>, run: (POST: (r: Request) => Promise<Response>) => Promise<void>) =>
  test(name, async () => {
    world = freshWorld();
    const { POST } = await loadRoute();
    await withEnv(env, () => run(POST));
  });

scenario("a signed-in owner's answer is spoken from the stored text, and the booking stays", ON_ENV, async (POST) => {
  const response = await POST(request({ messageId: "msg_1", chunk: 0, text: "something else entirely" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("x-readout-chunks"), "1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7, 7, 7]);
  assert.equal(world.providerCalls.length, 1);
  assert.equal(world.providerCalls[0].body.input, "Here is the answer you asked for.\nThat is all.");
  assert.deepEqual(world.rateLimitScopes, ["chat-readout"]);
  // Account day + provider day + provider month, each the piece's length.
  const characters = "Here is the answer you asked for.\nThat is all.".length;
  assert.equal(booked(), characters * 3);
});

scenario("a guest is refused before the budget or the provider", ON_ENV, async (POST) => {
  world.userId = null;
  const response = await POST(request({ messageId: "msg_1", chunk: 0 }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "READOUT_AUTH_REQUIRED");
  assert.equal(world.providerCalls.length, 0);
  assert.equal(booked(), 0);
});

for (const [name, env, priceRefusal, apiKey] of [
  ["the switch off", {}, null, "sk"],
  ["the switch not exactly true", { ...ON_ENV, CHAT_SERVER_READOUT_ENABLED: "TRUE" }, null, "sk"],
  ["the kill switch", { ...ON_ENV, CHAT_SERVER_READOUT_KILL_SWITCH: "1" }, null, "sk"],
  ["an unverified price", ON_ENV, { code: "cost_never_observed", detail: "" }, "sk"],
  ["no limits", { CHAT_SERVER_READOUT_ENABLED: "true" }, null, "sk"],
  ["no provider key", ON_ENV, null, null],
] as const) {
  scenario(`${name} answers READOUT_UNAVAILABLE and spends nothing`, env, async (POST) => {
    world.priceRefusal = priceRefusal;
    world.apiKey = apiKey;
    const response = await POST(request({ messageId: "msg_1", chunk: 0 }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "READOUT_UNAVAILABLE");
    assert.equal(world.providerCalls.length, 0);
    assert.equal(booked(), 0);
    assert.deepEqual(world.rateLimitScopes, []);
  });
}

scenario("another account's answer, a question, or a missing piece is refused unbooked", ON_ENV, async (POST) => {
  world.message = { ...world.message!, conversation: { ...world.message!.conversation, userId: "someone_else" } };
  assert.equal((await POST(request({ messageId: "msg_1", chunk: 0 }))).status, 404);
  world.message = { ...freshWorld().message!, role: "user" };
  assert.equal((await POST(request({ messageId: "msg_1", chunk: 0 }))).status, 409);
  world.message = freshWorld().message;
  const missing = await POST(request({ messageId: "msg_1", chunk: 3 }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "READOUT_NOTHING_TO_READ");
  world.unlocked = false;
  assert.equal((await POST(request({ messageId: "msg_1", chunk: 0 }))).status, 423);
  assert.equal(world.providerCalls.length, 0);
  assert.equal(booked(), 0);
});

scenario("an exhausted account day is a 429 with no provider call", { ...ON_ENV, CHAT_READOUT_CHARACTERS_PER_ACCOUNT_DAY: "60" }, async (POST) => {
  assert.equal((await POST(request({ messageId: "msg_1", chunk: 0 }))).status, 200);
  const before = booked();
  const refused = await POST(request({ messageId: "msg_1", chunk: 0 }));
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).code, "READOUT_LIMIT_REACHED");
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.equal(world.providerCalls.length, 1);
  assert.equal(booked(), before);
});

scenario("a provider refusal gives the booking back", ON_ENV, async (POST) => {
  world.provider = () => new Response("rate limited", { status: 429 });
  const response = await POST(request({ messageId: "msg_1", chunk: 0 }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "READOUT_PROVIDER_FAILED");
  assert.equal(world.providerCalls.length, 1);
  assert.equal(booked(), 0);
});

scenario("an unknown provider outcome keeps the booking and is not retried", ON_ENV, async (POST) => {
  for (const provider of [
    () => new Response("upstream", { status: 503 }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    world.rows.clear();
    world.providerCalls = [];
    world.provider = provider;
    const response = await POST(request({ messageId: "msg_1", chunk: 0 }));
    assert.equal(response.status, 502);
    assert.equal(world.providerCalls.length, 1);
    assert.ok(booked() > 0);
  }
});
