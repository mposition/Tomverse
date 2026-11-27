import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import * as aiModule from "ai";

/**
 * POST /api/chat for a durable Chat turn whose connection goes away
 * (lib/chatContinueAfterDisconnect.ts).
 *
 * Off -- the default -- a request abort cancels the turn, prorated, exactly
 * as before. On, a dropped connection without an explicit stop no longer
 * aborts the provider: the turn finishes and is saved and charged as
 * completed, and only a stop recorded in the attempt row (or a provider that
 * stops producing anything) cancels it. A stop that meets the final
 * checkpoint is a stop, never a free `failed` turn.
 *
 * Built on the same fixture shape as chat-route-stream-keepalive.test.ts,
 * with the attempt row held in memory so a stop can be written into it the
 * way the attempt endpoint would.
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
// Always replace an inherited key so this no-provider fixture cannot make a paid call.
process.env.OPENAI_API_KEY = "server-contract-test-key";

const MODEL_ID = "claude-haiku-4-5";
const USER_ID = "detach-user-1";
const CONVERSATION_ID = "detach-conversation-1";
const SOURCE_MESSAGE_ID = "11111111-2222-4333-8444-555555555555";
const ASSISTANT_MESSAGE_ID = "33333333-4444-4555-8666-777777777777";

const KEEPALIVE_INTERVAL_MS = 25;
const FIRST_TOKEN_DEADLINE_MS = 1_500;
process.env.CHAT_STREAM_KEEPALIVE_INTERVAL_MS = String(KEEPALIVE_INTERVAL_MS);
process.env.CHAT_FIRST_TOKEN_DEADLINE_MS = String(FIRST_TOKEN_DEADLINE_MS);
// The detached turn's own bounds, lowered through the operator seam.
process.env.CHAT_DETACHED_STOP_GRACE_MS = "100";
process.env.CHAT_DETACHED_STOP_POLL_MS = "25";
process.env.CHAT_DETACHED_PROVIDER_IDLE_MS = "1500";

mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: { requireMobileBearer: async () => ({ ok: false }) } });
mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => ({
      user: { id: USER_ID, email: "detach-qa@tomverse.app" },
    }),
  },
});

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

type Script = {
  /** The first visible chunk. */
  first: string;
  /**
   * What happens after it: `finish` waits for `releaseRest()` and then writes
   * `rest` and closes; `stall` never writes again.
   */
  then: "finish" | "stall";
  rest?: string;
  /** The unified finish reason the SDK resolves; `stop` when absent. */
  finishReason?: string;
};

let script: Script = { first: "Partial.", then: "finish", rest: " The end." };
let releaseRest = () => {};
let providerAbortReason: unknown = null;
let providerCancelled = false;
/** Runs as the provider is called -- after dispatch, before the Response exists. */
let onProviderCall: (() => void) | null = null;

mock.module("ai", {
  namedExports: {
    ...aiModule,
    streamText: (options: { abortSignal?: AbortSignal; onChunk?: (event: { chunk: unknown }) => unknown }) => {
      const observeAbort = () => {
        providerAbortReason = options.abortSignal?.reason ?? "aborted";
      };
      if (options.abortSignal?.aborted) observeAbort();
      else options.abortSignal?.addEventListener("abort", observeAbort, { once: true });
      onProviderCall?.();
      let text = "";
      const finished = new Promise<void>((settle) => {
        releaseRest = settle;
      });
      const result = {
        textStream: new ReadableStream<string>({
          start(controller) {
            controller.enqueue(script.first);
            text += script.first;
            options.onChunk?.({ chunk: { type: "text-delta", text: script.first } });
            if (script.then === "stall") return;
            void finished.then(() => {
              if (providerAbortReason !== null || providerCancelled) return;
              const rest = script.rest ?? "";
              options.onChunk?.({ chunk: { type: "text-delta", text: rest } });
              controller.enqueue(rest);
              text += rest;
              controller.close();
            });
          },
          cancel() {
            providerCancelled = true;
          },
        }),
        response: finished.then(() => ({
          id: "resp-detach-1",
          modelId: MODEL_ID,
          headers: {},
          messages: [],
        })),
        usage: finished.then(() => ({
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
        })),
        finishReason: finished.then(() => script.finishReason ?? "stop"),
        rawFinishReason: finished.then(() => "end_turn"),
        content: finished.then(() => [{ type: "text", text }]),
        providerMetadata: finished.then(() => ({})),
      };
      return result;
    },
  },
});

/* -------------------------------------------------------------------------- */
/* The attempt row                                                             */
/* -------------------------------------------------------------------------- */

class CasError extends Error {
  readonly code = "CHAT_ATTEMPT_REVISION_CONFLICT";
  constructor(readonly reason: string) {
    super("The Chat response attempt changed before this request was applied.");
  }
}

type Row = {
  assistantMessageId: string;
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
  fingerprint: string;
  requestedModelId: string;
  actualModelId: string | null;
  provider: string | null;
  status: string;
  partialContent: string;
  checkpointRevision: number;
  ownerId: string;
  leaseExpiresAt: Date;
  finishReason: string | null;
  failureCode: string | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
let row: Row | null = null;
/** Points in the completion branch a test may act at. */
const hooks: {
  afterCheckpoint?: (written: Row) => void;
  afterSettle?: (outcome: string) => void;
  inMessageTransaction?: () => void;
} = {};
/** Errors the next checkpoint writes throw, in order. */
let checkpointFailures: unknown[] = [];
/** Errors thrown by the next checkpoint writes *after* they committed. */
let checkpointAckLost: unknown[] = [];
const terminals: Array<{ status: string; writer: "owner" }> = [];
const isTerminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
/** What POST .../attempts/[id] {action: "stop"} writes. */
const stopFromEndpoint = () => {
  assert.ok(row && !isTerminal(row.status), "a stop needs an active attempt");
  row = {
    ...row,
    status: "cancelled",
    finishReason: "cancelled",
    failureCode: null,
    terminalAt: new Date(),
    checkpointRevision: row.checkpointRevision + 1,
  };
};

mock.module(mod("lib/chatResponseAttemptPersistence.ts"), {
  namedExports: {
    ChatAttemptCapacityError: class extends Error {},
    ChatAttemptCasError: CasError,
    ChatAttemptIdentityConflictError: class extends Error {},
    ChatAttemptScopeError: class extends Error {},
    claimChatResponseAttempt: async (input: Record<string, unknown>) => {
      row = {
        assistantMessageId: String(input.assistantMessageId),
        userId: String(input.userId),
        conversationId: String(input.conversationId),
        sourceUserMessageId: String(input.sourceUserMessageId),
        fingerprint: "a".repeat(64),
        requestedModelId: String(input.requestedModelId),
        actualModelId: null,
        provider: null,
        status: "claimed",
        partialContent: "",
        checkpointRevision: 0,
        ownerId: String(input.ownerId),
        leaseExpiresAt: input.leaseExpiresAt as Date,
        finishReason: null,
        failureCode: null,
        terminalAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return { disposition: "claimed", attempt: row };
    },
    checkpointChatResponseAttempt: async (input: { partialContent: string; expectedRevision: number }) => {
      assert.ok(row);
      const failure = checkpointFailures.shift();
      if (failure) throw failure;
      if (isTerminal(row.status)) throw new CasError("terminal");
      if (row.checkpointRevision !== input.expectedRevision) throw new CasError("revision_conflict");
      row = { ...row, status: "streaming", partialContent: input.partialContent, checkpointRevision: row.checkpointRevision + 1 };
      const written = row;
      hooks.afterCheckpoint?.(written);
      // The UPDATE committed and its answer was lost on the way back.
      const lostAck = checkpointAckLost.shift();
      if (lostAck) throw lostAck;
      return written;
    },
    terminalChatResponseAttempt: async (input: { status: string; finalContent: string; expectedRevision: number }) => {
      assert.ok(row);
      if (isTerminal(row.status)) throw new CasError("terminal");
      if (row.checkpointRevision !== input.expectedRevision) throw new CasError("revision_conflict");
      row = { ...row, status: input.status, partialContent: input.finalContent, checkpointRevision: row.checkpointRevision + 1, terminalAt: new Date() };
      terminals.push({ status: input.status, writer: "owner" });
      return row;
    },
    peekChatResponseAttempt: async () => row,
    readChatResponseAttempt: async () => row,
  },
});

mock.module(mod("lib/chatDurableSourceMessage.ts"), {
  namedExports: {
    ChatSourceMessageMismatchError: class extends Error {},
    verifyDurableChatSourceMessage: async () => undefined,
  },
});

const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    ...realApiSecurity,
    consumeApiRateLimit: async () => undefined,
  },
});

/* -------------------------------------------------------------------------- */
/* The database                                                                */
/* -------------------------------------------------------------------------- */

const world = {
  messages: [] as Array<{ id: string; content?: unknown }>,
  /** Errors the next assistant `message.create` calls throw, in order. */
  createFailures: [] as unknown[],
  /** Errors thrown by the next transactions *after* they committed. */
  commitAckLost: [] as unknown[],
  /** The route's read-back of its own assistant row fails. */
  commitCheckFails: false,
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
  productKey: "chat",
  chatRecoveryEpoch: 0,
};

const OVERRIDES: Record<string, Record<string, (args: never) => unknown>> = {
  user: { findUnique: () => ({ id: USER_ID, email: "detach-qa@tomverse.app", name: "Fixture", accountStatus: "active" }) },
  conversation: {
    findUnique: () => conversationRow,
    findFirst: () => conversationRow,
  },
  message: {
    findFirst: ((args: { where?: { role?: string } }) => {
      // The route's commit check reads its own assistant row back.
      if (args?.where?.role === "assistant" && world.commitCheckFails) {
        throw Object.assign(new Error("connection closed"), {
          name: "PrismaClientKnownRequestError",
          code: "P1017",
        });
      }
      return { id: SOURCE_MESSAGE_ID };
    }) as (args: never) => unknown,
    create: (args: { data: { id: string; content?: unknown } }) => {
      const failure = world.createFailures.shift();
      if (failure) throw failure;
      hooks.inMessageTransaction?.();
      world.messages.push({ ...args.data });
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
      return async (arg: unknown) => {
        if (typeof arg !== "function") return Promise.all(arg as unknown[]);
        // A transaction that throws rolls its Message back, as Postgres would.
        const messagesBefore = world.messages.length;
        let result: unknown;
        try {
          result = await (arg as (tx: unknown) => unknown)(prismaProxy);
        } catch (error) {
          world.messages.length = messagesBefore;
          throw error;
        }
        // The COMMIT went through and its acknowledgement was lost.
        const lostAck = world.commitAckLost.shift();
        if (lostAck) throw lostAck;
        return result;
      };
    }
    if (property === "$connect" || property === "$disconnect") return async () => undefined;
    if (property === "$executeRaw" || property === "$executeRawUnsafe") return async () => 0;
    if (property === "$queryRaw" || property === "$queryRawUnsafe") return async () => [];
    if (!(property in target)) {
      (target as Record<string, unknown>)[property] = modelProxy(property);
    }
    return (target as Record<string, unknown>)[property];
  },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaProxy } });

/* -------------------------------------------------------------------------- */
/* Money and slots                                                             */
/* -------------------------------------------------------------------------- */

const realChatSecurity = require(resolve(ROOT, "lib/chatSecurity.ts")) as Record<string, unknown>;
const ledger = {
  settlements: [] as Array<{ outcome: string }>,
  releases: [] as Array<{ leaseId: string }>,
};
mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => ({
      leaseId: "lease-detach-1",
      setCookie: undefined,
      usageReservation: {
        reservationId: "reservation-detach-1",
        userId: USER_ID,
        traceId: "trace-detach-1",
        source: "chat" as const,
        modelId: MODEL_ID,
        provider: "anthropic" as const,
        entries: [],
      },
    }),
    releaseChatAccess: async (leaseId: string) => {
      ledger.releases.push({ leaseId });
    },
    heartbeatChatAccess: async () => true,
    settleChatUsage: async (_reservation: unknown, usage: { outcome?: string }) => {
      ledger.settlements.push({ outcome: usage?.outcome ?? "unknown" });
      hooks.afterSettle?.(usage?.outcome ?? "unknown");
    },
    linkChatReservationProviderRequest: async () => undefined,
    reserveAttemptProviderBudget: async () => ({ ok: true, entries: [] }),
    releaseAttemptProviderBudget: async () => undefined,
  },
});
mock.module(mod("lib/activeAiModel.ts"), {
  namedExports: { getActiveAiModel: () => ({ modelId: MODEL_ID }) },
});
/** Provider and model health, as the route reports it. */
const health = { providerFailures: [] as string[], modelFailures: [] as string[] };
const realProviderMonitoring = require(resolve(ROOT, "lib/providerMonitoring.ts")) as Record<string, unknown>;
mock.module(mod("lib/providerMonitoring.ts"), {
  namedExports: {
    ...realProviderMonitoring,
    recordProviderFailure: async (_provider: string, diagnosticCode: string) => {
      health.providerFailures.push(diagnosticCode);
    },
    recordModelFailure: async (_modelId: string, _provider: string, diagnosticCode: string) => {
      health.modelFailures.push(diagnosticCode);
    },
    recordProviderSuccess: async () => undefined,
    recordModelSuccess: async () => undefined,
  },
});
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

/* -------------------------------------------------------------------------- */
/* Driving the route                                                           */
/* -------------------------------------------------------------------------- */

type RouteModule = { POST: (request: Request) => Promise<Response> };
let routePromise: Promise<RouteModule> | null = null;
const loadRoute = () => {
  routePromise ??= import(mod("app/api/chat/route.ts")) as Promise<RouteModule>;
  return routePromise;
};

const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 8_000;
  const anchor = setInterval(() => {}, 20);
  try {
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((settle) => setTimeout(settle, 10));
    }
  } finally {
    clearInterval(anchor);
  }
};
const pause = (ms: number) => {
  const anchor = setInterval(() => {}, 20);
  return new Promise<void>((settle) => setTimeout(() => {
    clearInterval(anchor);
    settle();
  }, ms));
};

/**
 * Sends a durable turn, reads its first visible chunk, and returns the
 * response and an abort for the request's connection.
 */
const start = async (next: Script, switchOn: boolean) => {
  script = next;
  providerAbortReason = null;
  providerCancelled = false;
  row = null;
  terminals.length = 0;
  world.messages = [];
  ledger.settlements = [];
  ledger.releases = [];
  if (switchOn) process.env.CHAT_CONTINUE_AFTER_DISCONNECT = "on";
  else delete process.env.CHAT_CONTINUE_AFTER_DISCONNECT;

  const connection = new AbortController();
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "긴 답을 써 줘", id: SOURCE_MESSAGE_ID }],
        modelId: MODEL_ID,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        sourceUserMessageId: SOURCE_MESSAGE_ID,
      }),
      signal: connection.signal,
    })
  );
  if (response.status !== 200) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  assert.equal(response.headers.get("X-Chat-Response-Mode"), "stream", "the fixture turn must be durable");
  const reader = response.body!.getReader();
  const anchor = setInterval(() => {}, 20);
  const first = await reader.read().finally(() => clearInterval(anchor));
  assert.ok(new TextDecoder().decode(first.value).includes(next.first));
  return {
    response,
    /** Reads the rest of the body, as a reader that stayed would. */
    readToEnd: async () => {
      const keep = setInterval(() => {}, 20);
      const decoder = new TextDecoder();
      let body = "";
      try {
        for (;;) {
          const read = await reader.read().catch(() => ({ done: true as const, value: undefined }));
          if (read.done) return body;
          body += decoder.decode(read.value, { stream: true });
        }
      } finally {
        clearInterval(keep);
      }
    },
    drop: (reason = "connection lost") => {
      connection.abort(reason);
      void reader.cancel(reason).catch(() => undefined);
    },
  };
};

test.afterEach(() => {
  delete process.env.CHAT_CONTINUE_AFTER_DISCONNECT;
  releaseRest();
});

/* -------------------------------------------------------------------------- */

test("switch off: a dropped connection cancels the durable turn exactly as before", async () => {
  const { response, drop } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
  assert.equal(response.headers.get("X-Chat-Continue-After-Disconnect"), null);
  drop();
  await until("the cancelled settlement", () => ledger.settlements.length > 0);
  releaseRest();
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.ok(providerAbortReason !== null, "the provider must be aborted with the switch off");
  assert.deepEqual(world.messages, []);
  assert.deepEqual(terminals.map((t) => t.status), ["cancelled"]);
});

test("switch on: a dropped connection keeps the provider, and the turn completes and is charged as completed", async () => {
  const { response, drop } = await start({ first: "Partial.", then: "finish", rest: " The end." }, true);
  assert.equal(response.headers.get("X-Chat-Continue-After-Disconnect"), "on");
  drop();
  // Past the stop grace: nobody stopped it, so it carries on.
  await pause(200);
  assert.equal(providerAbortReason, null, "a disconnect must not abort the provider");
  assert.equal(ledger.settlements.length, 0);
  releaseRest();
  await until("the completed settlement", () => ledger.settlements.length > 0);
  assert.equal(ledger.settlements[0].outcome, "completed");
  await until("the saved answer", () => world.messages.length > 0);
  assert.equal(world.messages[0].content, "Partial. The end.");
  assert.deepEqual(terminals.map((t) => t.status), ["completed"]);
  assert.equal(providerAbortReason, null);
  await until("the lease release", () => ledger.releases.length > 0);
});

test("switch on: a stop recorded before the abort cancels at once, prorated", async () => {
  const { drop } = await start({ first: "Partial.", then: "finish", rest: " The end." }, true);
  stopFromEndpoint();
  drop("client pressed stop");
  await until("the cancelled settlement", () => ledger.settlements.length > 0);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.ok(providerAbortReason !== null, "a stop must abort the provider");
  releaseRest();
  await pause(50);
  assert.deepEqual(world.messages, []);
  // The row was the endpoint's to terminalize; the owner wrote nothing over it.
  assert.deepEqual(terminals, []);
  assert.equal(row?.status, "cancelled");
});

test("switch on: a stop that lands after the disconnect is found by the detached watch", async () => {
  const { drop } = await start({ first: "Partial.", then: "finish", rest: " The end." }, true);
  drop();
  await pause(200);
  assert.equal(ledger.settlements.length, 0, "still running, detached");
  stopFromEndpoint();
  await until("the cancelled settlement", () => ledger.settlements.length > 0);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.ok(providerAbortReason !== null);
  releaseRest();
  await pause(50);
  assert.deepEqual(world.messages, []);
});

test("switch on: a detached provider that stops producing is cancelled, not left running", async () => {
  const { drop } = await start({ first: "Partial.", then: "stall" }, true);
  drop();
  await until("the cancelled settlement", () => ledger.settlements.length > 0);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.ok(providerAbortReason !== null);
  await until("the lease release", () => ledger.releases.length > 0);
});

test("a stop that meets the final checkpoint settles as a stop, never as a free failure", async () => {
  // Connected the whole way: the stop is recorded while the provider is
  // finishing, so the completion branch's final CAS is the first to see it.
  const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, true);
  stopFromEndpoint();
  releaseRest();
  await readToEnd();
  await until("the settlement", () => ledger.settlements.length > 0);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.notEqual(ledger.settlements[0].outcome, "failed");
  assert.deepEqual(world.messages, []);
});

/*
  S3 on the durable path. The Message transaction also carries the attempt's
  terminal CAS, so a re-run after a rollback has to land on the same final
  checkpoint revision -- and does, because a rollback moves nothing.
*/
const retryableWriteError = () =>
  Object.assign(new Error("connection closed"), {
    name: "PrismaClientKnownRequestError",
    code: "P1017",
  });

test("a durable turn whose Message write fails once is retried and completes once", async () => {
  world.createFailures = [retryableWriteError()];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    await readToEnd();
    await until("the saved answer", () => world.messages.length > 0);
    assert.equal(world.messages.length, 1);
    assert.equal(world.messages[0].content, "Partial. The end.");
    assert.deepEqual(terminals.map((t) => t.status), ["completed"]);
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
  } finally {
    world.createFailures = [];
  }
});

test("a durable turn whose Message write keeps failing ends failed, still settled once", async () => {
  world.createFailures = [retryableWriteError(), retryableWriteError(), retryableWriteError()];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    assert.deepEqual(world.messages, []);
    assert.deepEqual(terminals.map((t) => t.status), ["failed"]);
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
  } finally {
    world.createFailures = [];
  }
});

/*
  S4 (b). What fails after the provider's stream reported done -- the final
  checkpoint's CAS, a database error in the Message write -- is this
  application's own completion handling. It was filed as a provider and a
  model failure because the route always classified with `phase: "read"`.
*/
test("a Message write that keeps failing is not filed as a provider or model failure", async () => {
  health.providerFailures = [];
  health.modelFailures = [];
  world.createFailures = [retryableWriteError(), retryableWriteError(), retryableWriteError()];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    assert.deepEqual(terminals.map((t) => t.status), ["failed"]);
    assert.deepEqual(health.providerFailures, []);
    assert.deepEqual(health.modelFailures, []);
  } finally {
    world.createFailures = [];
  }
});

test("a refused final checkpoint that is not the user's stop is not a provider failure", async () => {
  health.providerFailures = [];
  health.modelFailures = [];
  const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
  // Another writer moved the row on: the lease is no longer this request's.
  assert.ok(row);
  row = { ...row, checkpointRevision: row.checkpointRevision + 5 };
  releaseRest();
  await readToEnd();
  await until("the settlement", () => ledger.settlements.length > 0);
  assert.equal(ledger.settlements[0].outcome, "failed");
  assert.deepEqual(world.messages, []);
  assert.deepEqual(health.providerFailures, []);
  assert.deepEqual(health.modelFailures, []);
});

test("a transient checkpoint failure does not fail a turn the user read to the end", async (t) => {
  t.mock.method(console, "warn", () => {});
  health.providerFailures = [];
  checkpointFailures = [retryableWriteError()];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    await readToEnd();
    await until("the saved answer", () => world.messages.length > 0);
    assert.equal(world.messages[0].content, "Partial. The end.");
    assert.deepEqual(terminals.map((t) => t.status), ["completed"]);
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
    assert.equal(row?.partialContent, "Partial. The end.");
    assert.deepEqual(health.providerFailures, []);
  } finally {
    checkpointFailures = [];
  }
});

/*
  S2 on the durable path. A provider error part mid-answer resolves the
  finish reason as `error` without throwing. The answer is saved incomplete,
  the turn settles prorated (`cancelled`) -- and the Message transaction, not
  the cancelled settlement, ends the attempt, so attempt and Message agree.
*/
test("a durable answer the provider broke off is saved incomplete, settled prorated, and filed as a provider failure", async () => {
  health.providerFailures = [];
  health.modelFailures = [];
  const { readToEnd } = await start(
    { first: "Partial.", then: "finish", rest: " The en", finishReason: "error" },
    false
  );
  releaseRest();
  await readToEnd();
  await until("the saved answer", () => world.messages.length > 0);
  assert.equal((world.messages[0] as { status?: string }).status, "incomplete");
  assert.equal(world.messages[0].content, "Partial. The en");
  assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["cancelled"]);
  assert.deepEqual(terminals.map((t) => t.status), ["completed"]);
  assert.equal(row?.status, "completed");
  assert.deepEqual(health.providerFailures, ["AI_STREAM_FAILED.INTERRUPTED"]);
  assert.deepEqual(health.modelFailures, ["AI_STREAM_FAILED.INTERRUPTED"]);
});

/* -------------------------------------------------------------------------- */
/* Review r-20261127-023116-0f6e2b                                             */
/* -------------------------------------------------------------------------- */

/*
  Major 1. A Stop pressed before the response's headers reached the browser
  aborted the fetch without the stop request (the browser only learns from the
  header that it must say one), and a server with the switch on detached that
  abort as a dropped connection and finished -- charged as completed. An abort
  that arrives before the Response is published is a cancel, as with the
  switch off: the browser has received nothing and cannot reattach.
*/
test("switch on: an abort after dispatch but before the response is published cancels, never continues", async () => {
  script = { first: "Partial.", then: "finish", rest: " The end." };
  providerAbortReason = null;
  providerCancelled = false;
  row = null;
  terminals.length = 0;
  world.messages = [];
  ledger.settlements = [];
  ledger.releases = [];
  process.env.CHAT_CONTINUE_AFTER_DISCONNECT = "on";
  const connection = new AbortController();
  onProviderCall = () => connection.abort("stop pressed before the headers arrived");
  try {
    const { POST } = await loadRoute();
    const anchor = setInterval(() => {}, 20);
    const response = await POST(
      new Request("http://127.0.0.1:3100/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "긴 답을 써 줘", id: SOURCE_MESSAGE_ID }],
          modelId: MODEL_ID,
          conversationId: CONVERSATION_ID,
          assistantMessageId: ASSISTANT_MESSAGE_ID,
          sourceUserMessageId: SOURCE_MESSAGE_ID,
        }),
        signal: connection.signal,
      })
    ).finally(() => clearInterval(anchor));
    // The provider finishes at once: a turn that was (wrongly) detached
    // would now complete, not stall into the idle cancel.
    releaseRest();
    await response.body?.cancel().catch(() => undefined);
    await until("the settlement", () => ledger.settlements.length > 0);
    await pause(150);
    assert.equal(ledger.settlements[0].outcome, "cancelled");
    assert.equal(ledger.settlements.length, 1);
    assert.notEqual(providerAbortReason, null, "the provider must be aborted, not left generating");
    assert.deepEqual(world.messages, []);
    assert.ok(!terminals.some((t) => t.status === "completed"), "a stopped turn was completed");
  } finally {
    onProviderCall = null;
  }
});

/*
  Major 2 on the durable path. The COMMIT went through, its acknowledgement
  was lost, and the commit check failed too: the outcome is unknown. Nothing
  may be decided on a guess -- the terminal `failed` CAS is refused by the
  committed row rather than written over it, and the stream ends without a
  signed failure so the browser reads the attempt row, which says completed.
*/
test("a durable write whose commit is unknown leaves the attempt row the judge", async () => {
  const previousSecret = process.env.ERROR_REPORT_SIGNING_SECRET;
  process.env.ERROR_REPORT_SIGNING_SECRET = "an-error-report-secret-of-32-chars!!";
  health.providerFailures = [];
  world.commitAckLost = [retryableWriteError()];
  world.commitCheckFails = true;
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    const body = await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    assert.equal(world.messages.length, 1, "the transaction committed");
    assert.equal(row?.status, "completed");
    assert.deepEqual(terminals.map((t) => t.status), ["completed"], "a committed attempt was marked failed");
    assert.doesNotMatch(body, /TOMVERSE_SEARCH_METADATA/, "a signed failure would stop the browser reading the attempt");
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
    assert.deepEqual(health.providerFailures, []);
  } finally {
    world.commitAckLost = [];
    world.commitCheckFails = false;
    if (previousSecret === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previousSecret;
  }
});

test("a durable write known not to have committed still ends with its signed failure", async () => {
  const previousSecret = process.env.ERROR_REPORT_SIGNING_SECRET;
  process.env.ERROR_REPORT_SIGNING_SECRET = "an-error-report-secret-of-32-chars!!";
  world.createFailures = [retryableWriteError(), retryableWriteError(), retryableWriteError()];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    const body = await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    assert.deepEqual(terminals.map((t) => t.status), ["failed"]);
    assert.match(body, /TOMVERSE_SEARCH_METADATA/);
  } finally {
    world.createFailures = [];
    if (previousSecret === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previousSecret;
  }
});

/* -------------------------------------------------------------------------- */
/* Review r-20261127-025915-939c77                                             */
/* -------------------------------------------------------------------------- */

/*
  Major 1. Once the final checkpoint's CAS has passed, the completed
  settlement owns the turn. A stop the attempt endpoint records after that --
  before the settlement, between it and the Message transaction, or inside
  that transaction -- used to leave the turn charged as completed with its
  Message refused by the terminal CAS. The invariant: a turn settled as
  completed is saved. The row keeps the user's stop; the Message is written.
*/
const FULL_ANSWER = "Partial. The end.";
const lateStopOrders: Array<[string, () => void]> = [
  ["right after the final checkpoint, before the settlement", () => {
    hooks.afterCheckpoint = (written) => {
      if (written.partialContent === FULL_ANSWER && !isTerminal(written.status)) {
        hooks.afterCheckpoint = undefined;
        stopFromEndpoint();
      }
    };
  }],
  ["after the settlement, before the Message transaction", () => {
    hooks.afterSettle = (outcome) => {
      hooks.afterSettle = undefined;
      if (outcome === "completed") stopFromEndpoint();
    };
  }],
  ["inside the Message transaction, before its terminal CAS", () => {
    hooks.inMessageTransaction = () => {
      hooks.inMessageTransaction = undefined;
      stopFromEndpoint();
    };
  }],
];
for (const [when, arm] of lateStopOrders) {
  test(`a stop recorded ${when} never leaves a completed charge without its saved answer`, async () => {
    try {
      const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, true);
      arm();
      releaseRest();
      await readToEnd();
      await until("the lease release", () => ledger.releases.length > 0);
      const outcomes = ledger.settlements.map((s) => s.outcome);
      assert.deepEqual(outcomes, ["completed"], "the completed settlement already owned the turn");
      // completed <=> saved.
      assert.equal(world.messages.length, 1, "a turn charged as completed was not saved");
      assert.equal(world.messages[0].content, FULL_ANSWER);
      // The row keeps the user's stop; the owner wrote nothing over it.
      assert.equal(row?.status, "cancelled");
      assert.deepEqual(terminals, []);
    } finally {
      hooks.afterCheckpoint = undefined;
      hooks.afterSettle = undefined;
      hooks.inMessageTransaction = undefined;
    }
  });
}

test("a stop that the final checkpoint meets is still a prorated stop with nothing saved", async () => {
  // The other side of the same boundary (unchanged): stop first, then the
  // final CAS refuses, and the turn never becomes completed.
  const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, true);
  stopFromEndpoint();
  releaseRest();
  await readToEnd();
  await until("the settlement", () => ledger.settlements.length > 0);
  assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["cancelled"]);
  assert.deepEqual(world.messages, []);
});

/*
  Major 2 at the route. A checkpoint whose UPDATE committed and whose answer
  was lost left the writer one revision behind its row; the retry was refused
  as a conflict, latched, and the final flush failed the turn the user had
  read. The writer now reads the row before writing again and catches up.
*/
test("a checkpoint that committed but lost its answer does not fail the turn", async (t) => {
  t.mock.method(console, "warn", () => {});
  checkpointAckLost = [retryableWriteError()];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." }, false);
    releaseRest();
    await readToEnd();
    await until("the saved answer", () => world.messages.length > 0);
    assert.equal(world.messages[0].content, "Partial. The end.");
    assert.deepEqual(terminals.map((t) => t.status), ["completed"]);
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
  } finally {
    checkpointAckLost = [];
  }
});
