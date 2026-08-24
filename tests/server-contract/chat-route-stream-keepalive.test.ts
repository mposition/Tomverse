import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import * as aiModule from "ai";

/**
 * What POST /api/chat writes while a provider is thinking, and what it does
 * when the provider never stops.
 *
 * ## The turn this is about
 *
 * `claude-fable-5` runs adaptive thinking at `effort: "high"`
 * (lib/modelGenerationCompatibility.ts). Between the response headers and its
 * first token, minutes can pass with nothing on the wire. This deployment
 * sits behind an edge proxy whose read timeout is roughly 125 seconds
 * (docs/policy/image-generation.md section 7), so that silence is not merely
 * a client-side timer problem: the connection itself does not survive it.
 *
 * So the route writes a NUL-led keepalive every
 * CHAT_STREAM_KEEPALIVE_INTERVAL_MS while no visible token has gone out, and
 * gives up at CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS. Both constants are mocked
 * down to milliseconds here -- the point of putting them in a module of their
 * own was that a test would never have to wait nine minutes to execute them.
 *
 * ## What the giving-up has to do
 *
 * A keepalive that never ends would hide a dead provider forever, so the
 * deadline is not optional and neither is its cleanup. This file asserts all
 * of it: the terminal `stalled` notice reaches the client, the provider's own
 * reader is cancelled, the reservation is settled, the concurrency lease is
 * released, and no assistant message is written for an answer that never
 * existed.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.ANTHROPIC_API_KEY ||= "server-contract-test-key";

const MODEL_ID = "claude-haiku-4-5";
const USER_ID = "keepalive-user-1";
const CONVERSATION_ID = "keepalive-conversation-1";
const ASSISTANT_MESSAGE_ID = "22222222-3333-4444-8555-666666666666";

/*
  Milliseconds, so the suite runs in seconds rather than in nine-minute
  budgets -- but chosen so that nothing here is a race against a loaded
  machine.

  The first version of this file used 40ms and 260ms and asserted an exact
  keepalive count. It passed locally and failed all four cases on CI, because
  both directions of that assertion are wall-clock bets: a starved event loop
  fires fewer ticks than the arithmetic predicts, and a fast turn that should
  see none can still be overtaken by one if the read is delayed past a single
  interval. The interval is now small against a deadline long enough that even
  a badly loaded runner gets many ticks, and the assertions below are about
  what the contract actually says rather than about how many.
*/
const KEEPALIVE_INTERVAL_MS = 25;
const FIRST_TOKEN_DEADLINE_MS = 1_500;

/* -------------------------------------------------------------------------- */
/* The liveness budgets, shrunk                                               */
/* -------------------------------------------------------------------------- */

/*
  Through the environment, not through `mock.module`.

  The first version of this file replaced the two constants with a module
  mock. It worked locally and did not apply on CI at all: the route kept its
  nine-minute deadline and all four cases died on the guard below, twice, with
  `540000 !== 260`. A seam whose behaviour differs between two machines
  running the same Node major is not a seam, so the route now reads these
  through `lib/chatStreamKeepalivePlan.ts` and this sets them the way an
  operator would.
*/
process.env.CHAT_STREAM_KEEPALIVE_INTERVAL_MS = String(KEEPALIVE_INTERVAL_MS);
process.env.CHAT_FIRST_TOKEN_DEADLINE_MS = String(FIRST_TOKEN_DEADLINE_MS);

mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => ({
      user: { id: USER_ID, email: "keepalive-qa@tomverse.app" },
    }),
  },
});

/* -------------------------------------------------------------------------- */
/* The provider stream this turn gets                                          */
/* -------------------------------------------------------------------------- */

type Script = {
  /**
   * Text the provider produces, or `null` for a provider that opens its
   * stream and then says nothing at all -- the stall this file is about.
   */
  text: string | null;
};

let script: Script = { text: "The answer." };

/** Set by the fake stream's own `cancel`, which is what the route must call. */
let sourceCancelReason: unknown = null;

mock.module("ai", {
  namedExports: {
    ...aiModule,
    streamText: () => ({
      textStream: new ReadableStream<string>({
        start(controller) {
          if (script.text === null) return; // never resolves on its own
          controller.enqueue(script.text);
          controller.close();
        },
        cancel(reason) {
          sourceCancelReason = reason ?? "cancelled";
        },
      }),
      response: Promise.resolve({
        id: "resp-keepalive-1",
        modelId: MODEL_ID,
        headers: {},
        messages: [],
      }),
      usage: Promise.resolve({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 0 },
        outputTokenDetails: { reasoningTokens: 0 },
      }),
      finishReason: Promise.resolve("stop"),
      rawFinishReason: Promise.resolve("end_turn"),
      content: Promise.resolve([]),
      providerMetadata: Promise.resolve({}),
    }),
  },
});

/* -------------------------------------------------------------------------- */
/* The database                                                                */
/* -------------------------------------------------------------------------- */

const world = {
  messages: [] as Array<{ id: string; status: string }>,
};

const DEFAULTS: Record<string, () => unknown> = {
  findUnique: () => null,
  findFirst: () => null,
  findUniqueOrThrow: () => null,
  findMany: () => [],
  create: () => ({}),
  createMany: () => ({ count: 0 }),
  update: () => ({}),
  updateMany: () => ({ count: 0 }),
  upsert: () => ({}),
  delete: () => ({}),
  deleteMany: () => ({ count: 0 }),
  count: () => 0,
  aggregate: () => ({ _sum: {}, _count: 0 }),
  groupBy: () => [],
};

const conversationRow = {
  id: CONVERSATION_ID,
  userId: USER_ID,
  password: null,
  selectedModels: JSON.stringify([MODEL_ID]),
  kind: "chat",
};

const OVERRIDES: Record<string, Record<string, (args: never) => unknown>> = {
  conversation: {
    findUnique: () => conversationRow,
    findFirst: () => conversationRow,
  },
  message: {
    findFirst: () => ({ id: "user-message-1" }),
    create: (args: { data: { id: string; status: string } }) => {
      world.messages.push({ id: args.data.id, status: args.data.status });
      return args.data;
    },
  },
};

const modelProxy = (model: string) =>
  new Proxy(
    {},
    {
      get: (_target, verb: string) => {
        const override = OVERRIDES[model]?.[verb];
        const fallback = DEFAULTS[verb];
        if (!override && !fallback) return undefined;
        return async (args: never) => (override ? override(args) : fallback!());
      },
    }
  );

const prismaFake: Record<string, unknown> = {};
const prismaProxy: unknown = new Proxy(prismaFake, {
  get: (target, property: string) => {
    if (property === "then") return undefined;
    if (property === "$transaction") {
      return async (arg: unknown) =>
        typeof arg === "function"
          ? (arg as (tx: unknown) => unknown)(prismaProxy)
          : Promise.all(arg as unknown[]);
    }
    if (property === "$connect" || property === "$disconnect") {
      return async () => undefined;
    }
    if (property === "$executeRaw" || property === "$executeRawUnsafe") {
      return async () => 0;
    }
    if (property === "$queryRaw" || property === "$queryRawUnsafe") {
      return async () => [];
    }
    if (!(property in target)) {
      (target as Record<string, unknown>)[property] = modelProxy(property);
    }
    return (target as Record<string, unknown>)[property];
  },
});

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaProxy } });

/* -------------------------------------------------------------------------- */
/* The seams that cost money and hold slots                                    */
/* -------------------------------------------------------------------------- */

const realChatSecurity = require(resolve(ROOT, "lib/chatSecurity.ts")) as Record<
  string,
  unknown
>;

const reservation = {
  reservationId: "reservation-keepalive-1",
  userId: USER_ID,
  traceId: "trace-keepalive-1",
  source: "chat" as const,
  modelId: MODEL_ID,
  provider: "anthropic" as const,
  entries: [],
};

const ledger = {
  settlements: [] as Array<{ outcome: string }>,
  releases: [] as Array<{ leaseId: string; reason?: string }>,
  heartbeats: 0,
};

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => ({
      leaseId: "lease-keepalive-1",
      setCookie: undefined,
      usageReservation: reservation,
    }),
    releaseChatAccess: async (
      leaseId: string,
      options?: { reason?: string }
    ) => {
      ledger.releases.push({ leaseId, reason: options?.reason });
    },
    heartbeatChatAccess: async () => {
      ledger.heartbeats += 1;
      return true;
    },
    settleChatUsage: async (
      _reservation: unknown,
      usage: { outcome?: string }
    ) => {
      ledger.settlements.push({ outcome: usage?.outcome ?? "unknown" });
    },
    linkChatReservationProviderRequest: async () => undefined,
    reserveAttemptProviderBudget: async () => ({ ok: true, entries: [] }),
    releaseAttemptProviderBudget: async () => undefined,
  },
});

mock.module(mod("lib/activeAiModel.ts"), {
  namedExports: { getActiveAiModel: () => ({ modelId: MODEL_ID }) },
});

globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

/* -------------------------------------------------------------------------- */
/* Driving the route                                                           */
/* -------------------------------------------------------------------------- */

type RouteModule = { POST: (request: Request) => Promise<Response> };

let routePromise: Promise<RouteModule> | null = null;

const loadRoute = async (): Promise<RouteModule> => {
  routePromise ??= (async () => {
    // The same call the route makes. Kept as a guard because a budget that
    // silently stayed at nine minutes is how this file failed on CI while
    // passing locally, and the failure has to name that rather than surface
    // as four unrelated-looking assertions.
    const { resolveChatStreamKeepalivePlan } = (await import(
      mod("lib/chatStreamKeepalivePlan.ts")
    )) as typeof import("../../lib/chatStreamKeepalivePlan");
    assert.deepEqual(
      resolveChatStreamKeepalivePlan(),
      {
        intervalMs: KEEPALIVE_INTERVAL_MS,
        firstTokenDeadlineMs: FIRST_TOKEN_DEADLINE_MS,
      },
      "the shrunk budgets did not reach the route, so this suite would wait " +
        "nine minutes per case"
    );
    const loaded = (await import(mod("app/api/chat/route.ts"))) as Partial<RouteModule>;
    if (typeof loaded.POST !== "function") {
      throw new Error(
        "app/api/chat/route.ts exported no POST. Its module graph did not " +
          `link. The namespace carried: [${Object.keys(loaded).join(", ")}]`
      );
    }
    return loaded as RouteModule;
  })();
  return routePromise;
};

/*
  Holds the event loop open for the duration of a read.

  The route's keepalive interval and first-token deadline are both `unref`ed,
  for the same reason the lease heartbeat is: a pending timer must never be
  why a worker stays up after its request is done. In production there is
  always a listening socket holding the loop; in this process there is
  nothing, so an `unref`ed timer would let node decide the run had finished
  while the stream was still waiting to be written to.
*/
const whileWaiting = async <T,>(read: () => Promise<T>): Promise<T> => {
  const anchor = setInterval(() => {}, 20);
  try {
    return await read();
  } finally {
    clearInterval(anchor);
  }
};

/**
 * Waits for something the route does asynchronously, without betting on when.
 *
 * A fixed sleep is the same wall-clock bet the constants above were: long
 * enough to be slow on every healthy run, and still too short on the one
 * loaded runner that matters. This polls instead, and fails with the
 * condition's own name rather than with a downstream assertion.
 */
const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + FIRST_TOKEN_DEADLINE_MS * 8;
  const anchor = setInterval(() => {}, 20);
  try {
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((settle) => setTimeout(settle, 20));
    }
  } finally {
    clearInterval(anchor);
  }
};

const ask = async (next: Script) => {
  script = next;
  sourceCancelReason = null;
  world.messages = [];
  ledger.settlements = [];
  ledger.releases = [];
  ledger.heartbeats = 0;

  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "이 자료를 분석해 줘" }],
        modelId: MODEL_ID,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
      }),
    })
  );
  if (response.status !== 200) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  return { response, body: await whileWaiting(() => response.text()) };
};

/*
  Read the way the client reads, with the real splitter, so a change to the
  wire format breaks this file instead of slipping past it.

  `createRequire` rather than a dynamic import: the mocked-module lane
  transforms this file to CJS, where a top-level await is not available.
*/
const { splitStreamKeepaliveSignal } = require(
  resolve(ROOT, "lib/chatStreamKeepalive.ts")
) as typeof import("../../lib/chatStreamKeepalive");

const countKeepalives = (body: string) =>
  body.split("TOMVERSE_STREAM_KEEPALIVE").length - 1;

/* -------------------------------------------------------------------------- */

test("a provider that never produces a token is kept alive, then given up on", async () => {
  const { body } = await ask({ text: null });

  // The connection was written to while the provider was silent. Without this
  // the edge closes it long before a high-reasoning first token.
  //
  // "at least one" rather than a count derived from interval and deadline:
  // what the contract says is that the connection does not go silent, and a
  // number here would only be asserting that the runner was not busy.
  assert.ok(
    countKeepalives(body) >= 1,
    `the stream went entirely silent while the provider was thinking: ${JSON.stringify(body)}`
  );

  // And the waiting ended: a keepalive that never stops is a dead provider
  // hidden forever.
  const split = splitStreamKeepaliveSignal(body);
  assert.equal(split.signal?.state, "stalled");
  assert.equal(split.signal?.code, "CHAT_FIRST_RESPONSE_TIMEOUT");

  // Every keepalive is out-of-band, so the answer the user would see is
  // empty rather than a wall of markers.
  assert.equal(split.text, "");
});

test("giving up cancels the provider stream, settles and releases the lease", async () => {
  await ask({ text: null });

  assert.ok(
    sourceCancelReason,
    "the provider's own stream was left open and billing"
  );
  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "failed");
  assert.equal(ledger.releases.length >= 1, true);

  // No answer existed, so no assistant message may be written for one.
  assert.deepEqual(world.messages, []);
});

test("a turn that answers is never marked stalled, and reads clean", async () => {
  const { body } = await ask({ text: "The answer." });

  const split = splitStreamKeepaliveSignal(body);
  // Not `countKeepalives(body) === 0`. With the real 20s interval a turn this
  // fast sees none, but asserting that here would be asserting that the
  // runner was not busy -- and it is not what the contract says. What matters
  // is that nothing about a keepalive reaches the user, and that a turn which
  // answered is not reported as one that stalled.
  assert.equal(split.signal?.state === "stalled", false);
  // `startsWith`, not equality: this splitter removes keepalives only, and the
  // turn's closing search-metadata trailer is still on the end of the stream.
  assert.ok(split.text.startsWith("The answer."));
  assert.equal(split.text.includes("TOMVERSE_STREAM_KEEPALIVE"), false);

  // The turn completed, so it settled as a completed turn and let its slot go.
  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "completed");
  assert.equal(ledger.releases.length >= 1, true);
});

test("a client that walks away stops the keepalive writer", async () => {
  // The browser closing the tab mid-wait. `cancel()` on the response stream
  // has to stop the interval as well as everything else, or a timer outlives
  // the request it belonged to and writes into a closed controller forever.
  script = { text: null };
  sourceCancelReason = null;
  ledger.settlements = [];
  ledger.releases = [];

  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "분석해 줘" }],
        modelId: MODEL_ID,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
      }),
    })
  );
  assert.equal(response.status, 200);

  const reader = response.body!.getReader();
  await whileWaiting(() => reader.read());
  await reader.cancel("client is gone");

  await until("the abandoned run to settle", () => ledger.settlements.length > 0);

  assert.ok(sourceCancelReason, "the provider stream was left open");
  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.equal(ledger.releases.length >= 1, true);
});
