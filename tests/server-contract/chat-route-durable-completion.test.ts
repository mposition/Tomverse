import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import * as aiModule from "ai";

/**
 * POST /api/chat's completion branch for a durable Chat turn (an attempt row):
 * the final checkpoint, the settlement, the Message transaction and the one
 * terminal transition of the attempt, for every shape a finished turn takes
 * and for each way the Message write can fail.
 *
 * Built on the same fixture shape as chat-route-stream-keepalive.test.ts,
 * with the attempt row held in memory and the file tools run by the fake
 * provider.
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
const USER_ID = "durable-user-1";
const CONVERSATION_ID = "durable-conversation-1";
const SOURCE_MESSAGE_ID = "11111111-2222-4333-8444-555555555555";
const ASSISTANT_MESSAGE_ID = "33333333-4444-4555-8666-777777777777";

const KEEPALIVE_INTERVAL_MS = 25;
const FIRST_TOKEN_DEADLINE_MS = 1_500;
process.env.CHAT_STREAM_KEEPALIVE_INTERVAL_MS = String(KEEPALIVE_INTERVAL_MS);
process.env.CHAT_FIRST_TOKEN_DEADLINE_MS = String(FIRST_TOKEN_DEADLINE_MS);

mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: { requireMobileBearer: async () => ({ ok: false }) } });
mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => ({
      user: { id: USER_ID, email: "durable-qa@tomverse.app" },
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
  /**
   * A file tool call the provider begins before its first text, and whether
   * the SDK then runs it (through the tool's own `execute`).
   */
  tool?: { toolName: string; toolCallId: string; execute: boolean; input?: unknown };
};

let script: Script = { first: "Partial.", then: "finish", rest: " The end." };
let releaseRest = () => {};
let providerAbortReason: unknown = null;
let providerCancelled = false;
/** Whether the last `readToEnd()` ended on a stream error rather than a close. */
let lastReadErrored = false;

mock.module("ai", {
  namedExports: {
    ...aiModule,
    streamText: (options: {
      abortSignal?: AbortSignal;
      onChunk?: (event: { chunk: unknown }) => unknown;
      onToolExecutionStart?: (event: { toolCall: { toolCallId: string; toolName: string } }) => unknown;
      tools?: Record<string, { execute?: (input: unknown, meta: { toolCallId: string }) => unknown }>;
    }) => {
      const observeAbort = () => {
        providerAbortReason = options.abortSignal?.reason ?? "aborted";
      };
      if (options.abortSignal?.aborted) observeAbort();
      else options.abortSignal?.addEventListener("abort", observeAbort, { once: true });
      let text = "";
      const finished = new Promise<void>((settle) => {
        releaseRest = settle;
      });
      const result = {
        textStream: new ReadableStream<string>({
          async start(controller) {
            const tool = script.tool;
            if (tool) {
              options.onChunk?.({ chunk: { type: "tool-input-start", toolCallId: tool.toolCallId, toolName: tool.toolName } });
              if (tool.execute) {
                options.onToolExecutionStart?.({ toolCall: { toolCallId: tool.toolCallId, toolName: tool.toolName } });
                await options.tools?.[tool.toolName]?.execute?.(tool.input, { toolCallId: tool.toolCallId });
              }
            }
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
          id: "resp-durable-1",
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
/** Errors the next checkpoint writes throw, in order. */
let checkpointFailures: unknown[] = [];
/** Errors thrown by the next checkpoint writes *after* they committed. */
let checkpointAckLost: unknown[] = [];
const terminals: Array<{ status: string; writer: "owner" }> = [];
const isTerminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
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
  /** Artifact rows the Message transaction wrote, and objects reclaimed. */
  artifactRows: [] as Array<{ messageId: string; ordinal: number; status: string; failureCode?: string }>,
  discarded: 0,
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
  messageArtifact: {
    createMany: ((args: { data: Array<{ messageId: string; ordinal: number; status: string; failureCode?: string }> }) => {
      world.artifactRows.push(...args.data);
      return { count: args.data.length };
    }) as (args: never) => unknown,
    findMany: (() =>
      world.artifactRows.map((row, index) => ({
        id: `row_${index + 1}`,
        ordinal: row.ordinal,
        parentArtifactId: null,
        lineageId: null,
      }))) as (args: never) => unknown,
  },
  user: { findUnique: () => ({ id: USER_ID, email: "durable-qa@tomverse.app", name: "Fixture", accountStatus: "active" }) },
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

// A stored artifact must not reach a real bucket.
const realArtifactStorage = require(resolve(ROOT, "lib/generatedArtifactStorage.ts")) as {
  persistArtifactRows: unknown;
};
mock.module(mod("lib/generatedArtifactStorage.ts"), {
  namedExports: {
    persistArtifactRows: realArtifactStorage.persistArtifactRows,
    putArtifactObject: async (input: {
      ordinal: number; format: string; filename: string; mediaType: string; bytes: Uint8Array; modelId: string | null;
    }) => ({
      id: `art_${input.ordinal}`,
      ordinal: input.ordinal,
      format: input.format,
      filename: input.filename,
      mediaType: input.mediaType,
      byteSize: input.bytes.byteLength,
      objectKey: `message-artifacts/${USER_ID}/${CONVERSATION_ID}/art_${input.ordinal}.${input.format}`,
      modelId: input.modelId,
    }),
    discardStoredArtifacts: async (artifacts: unknown[]) => {
      world.discarded += artifacts.length;
    },
  },
});

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
      leaseId: "lease-durable-1",
      setCookie: undefined,
      usageReservation: {
        reservationId: "reservation-durable-1",
        userId: USER_ID,
        traceId: "trace-durable-1",
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

/**
 * Sends a durable turn, reads its first visible chunk, and returns the
 * response and an abort for the request's connection.
 */
const start = async (next: Script) => {
  script = next;
  providerAbortReason = null;
  providerCancelled = false;
  row = null;
  terminals.length = 0;
  world.messages = [];
  world.artifactRows = [];
  world.discarded = 0;
  ledger.settlements = [];
  ledger.releases = [];

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
      lastReadErrored = false;
      try {
        for (;;) {
          const read = await reader.read().catch(() => {
            lastReadErrored = true;
            return { done: true as const, value: undefined };
          });
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
  releaseRest();
});

/* -------------------------------------------------------------------------- */

test("a dropped connection cancels the durable turn, prorated", async () => {
  const { drop } = await start({ first: "Partial.", then: "finish", rest: " The end." });
  drop();
  await until("the cancelled settlement", () => ledger.settlements.length > 0);
  releaseRest();
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.ok(providerAbortReason !== null, "a dropped connection must abort the provider");
  assert.deepEqual(world.messages, []);
  assert.deepEqual(terminals.map((t) => t.status), ["cancelled"]);
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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
  Review r-20261127-045409-cf6503. A file-only answer delivers nothing until
  its Message and file rows exist, so it is charged only once the save outcome
  is known: a known rollback discards the file and settles empty; a commit
  whose acknowledgement was lost keeps the file and its charge.
*/
const fileOnlyScript = (toolCallId: string): Script => ({
  first: "",
  then: "finish",
  rest: "",
  tool: {
    toolName: "create_text_file",
    toolCallId,
    execute: true,
    input: { filename: "page.html", format: "html", content: "<!doctype html><title>ok</title><p>ok</p>" },
  },
});

test("a file-only durable answer whose Message write keeps failing is not charged", async () => {
  world.createFailures = [retryableWriteError(), retryableWriteError(), retryableWriteError()];
  try {
    const { readToEnd } = await start(fileOnlyScript("call_file_rollback"));
    releaseRest();
    await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    await until("the settlement", () => ledger.settlements.length > 0);
    assert.deepEqual(world.messages, []);
    assert.deepEqual(world.artifactRows, []);
    assert.ok(world.discarded > 0, "the unreachable file was kept");
    assert.deepEqual(terminals.map((t) => t.status), ["failed"]);
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["empty"]);
  } finally {
    world.createFailures = [];
  }
});

test("a file-only durable answer whose commit acknowledgement was lost keeps its file and charge", async () => {
  world.commitAckLost = [retryableWriteError()];
  world.commitCheckFails = true;
  try {
    const { readToEnd } = await start(fileOnlyScript("call_file_unknown"));
    releaseRest();
    await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    await until("the settlement", () => ledger.settlements.length > 0);
    assert.equal(world.messages.length, 1, "the transaction committed");
    assert.deepEqual(world.artifactRows.map((r) => r.status), ["ready"]);
    assert.equal(world.discarded, 0);
    assert.equal(row?.status, "completed");
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
  } finally {
    world.commitAckLost = [];
    world.commitCheckFails = false;
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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

/*
  A full message store. The answer used to be charged, streamed and then
  refused at the Message write -- and that refusal was filed as the provider's
  and the model's failure. It is now refused before anything is reserved, and
  a refusal that still reaches the write (a concurrent turn took the last
  slot) is this application's, not the provider's.
*/
const { ApiSecurityError } = realApiSecurity as {
  ApiSecurityError: new (status: number, code: string, message: string) => Error;
};

test("an account at its message storage limit is refused before the turn is reserved or sent", async () => {
  const prior = process.env.API_MAX_MESSAGE_BYTES_PER_USER;
  // Less than one answer's worth of room.
  process.env.API_MAX_MESSAGE_BYTES_PER_USER = "1";
  // A fresh turn, as `start` makes one: no attempt left from the last test for
  // the pre-Router peek to find.
  row = null;
  terminals.length = 0;
  ledger.settlements = [];
  world.messages = [];
  try {
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
      })
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code?: string }).code, "MESSAGE_STORAGE_QUOTA_EXCEEDED");
    // Refused before the claim and the reservation: nothing settles, and no
    // attempt row is written for a turn that could never answer.
    assert.deepEqual(ledger.settlements, []);
    assert.deepEqual(world.messages, []);
    assert.equal(row, null, "no attempt was claimed");
    assert.deepEqual(terminals, []);
  } finally {
    if (prior === undefined) delete process.env.API_MAX_MESSAGE_BYTES_PER_USER;
    else process.env.API_MAX_MESSAGE_BYTES_PER_USER = prior;
  }
});

test("a storage refusal at the Message write is not filed as a provider or model failure", async () => {
  health.providerFailures = [];
  health.modelFailures = [];
  world.createFailures = [new ApiSecurityError(409, "MESSAGE_STORAGE_QUOTA_EXCEEDED", "Message storage quota exceeded.")];
  try {
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
    releaseRest();
    await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    assert.deepEqual(terminals.map((t) => t.status), ["failed"]);
    assert.deepEqual(health.providerFailures, []);
    assert.deepEqual(health.modelFailures, []);
    // Settled before the write, as the policy says: the answer was shown.
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["completed"]);
  } finally {
    world.createFailures = [];
  }
});

test("a refused final checkpoint is not a provider failure", async () => {
  health.providerFailures = [];
  health.modelFailures = [];
  const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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
    { first: "Partial.", then: "finish", rest: " The en", finishReason: "error" }
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

test("a file-only durable answer the provider broke off keeps its file and is settled prorated", async () => {
  health.providerFailures = [];
  health.modelFailures = [];
  const { readToEnd } = await start({
    first: "",
    then: "finish",
    rest: "",
    finishReason: "error",
    tool: {
      toolName: "create_text_file",
      toolCallId: "call_html_cut",
      execute: true,
      input: { filename: "page.html", format: "html", content: "<!doctype html><title>ok</title><p>ok</p>" },
    },
  });
  releaseRest();
  await readToEnd();
  await until("the saved answer", () => world.messages.length > 0);
  assert.equal((world.messages[0] as { status?: string }).status, "incomplete");
  assert.deepEqual(world.artifactRows.map((r) => r.status), ["ready"]);
  assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["cancelled"]);
  assert.deepEqual(terminals.map((t) => t.status), ["completed"]);
  assert.deepEqual(health.providerFailures, ["AI_STREAM_FAILED.INTERRUPTED"]);
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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
    const { readToEnd } = await start({ first: "Partial.", then: "finish", rest: " The end." });
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

/* -------------------------------------------------------------------------- */
/* Review r-20261127-033833-e39d74: one terminal transition per durable turn   */
/* -------------------------------------------------------------------------- */

/*
  Every completion shape a durable Chat turn can take, on the durable path:
  the attempt row is closed exactly once by its owner, the stream ends without
  an error, and settlement and storage agree. The orders the Message write
  itself can fail in (retried write, unknown outcome, known rollback) are pinned
  by the tests above.
*/
const { parseChatStreamTrailer, splitSearchMetadataTrailer } = require(
  resolve(ROOT, "lib/webSearchStreamTrailer.ts")
) as typeof import("../../lib/webSearchStreamTrailer");
const htmlFile = {
  toolName: "create_text_file",
  toolCallId: "call_html",
  execute: true,
  input: { filename: "page.html", format: "html", content: "<!doctype html><title>ok</title><p>ok</p>" },
};
const durableShapes: Array<{
  name: string;
  script: Script;
  settlement: string;
  terminal: string;
  saved: boolean;
  cards: string[];
}> = [
  { name: "an answer with text", script: { first: "Partial.", then: "finish", rest: " The end." },
    settlement: "completed", terminal: "completed", saved: true, cards: [] },
  { name: "a file with no text", script: { first: "", then: "finish", rest: "", tool: htmlFile },
    settlement: "completed", terminal: "completed", saved: true, cards: ["ready"] },
  { name: "a turn_incomplete card with no text",
    script: { first: "", then: "finish", rest: "", finishReason: "length",
      tool: { toolName: "create_text_file", toolCallId: "call_cut", execute: false } },
    settlement: "empty", terminal: "completed", saved: true, cards: ["failed"] },
  { name: "a failed generation card with no text",
    script: { first: "", then: "finish", rest: "",
      tool: { toolName: "create_text_file", toolCallId: "call_txt", execute: true,
        input: { format: "txt", filename: "notes.txt", content: "x" } } },
    settlement: "empty", terminal: "completed", saved: true, cards: ["failed"] },
  { name: "an answer the provider broke off",
    script: { first: "Partial.", then: "finish", rest: " The en", finishReason: "error" },
    settlement: "cancelled", terminal: "completed", saved: true, cards: [] },
  // Review r-20261127-041211-93f81f: the file is kept, but the provider broke
  // off, so the delivered file does not earn the flat completed charge.
  { name: "a file with no text the provider broke off",
    script: { first: "", then: "finish", rest: "", finishReason: "error", tool: htmlFile },
    settlement: "cancelled", terminal: "completed", saved: true, cards: ["ready"] },
  { name: "neither text nor any card", script: { first: "", then: "finish", rest: "" },
    settlement: "empty", terminal: "failed", saved: false, cards: [] },
];
for (const shape of durableShapes) {
  test(`durable: ${shape.name} closes its attempt once and ends the stream cleanly`, async () => {
    const { readToEnd } = await start(shape.script);
    releaseRest();
    const body = await readToEnd();
    await until("the lease release", () => ledger.releases.length > 0);
    await until("the settlement", () => ledger.settlements.length > 0);
    assert.equal(lastReadErrored, false, "a saved turn ended as a stream error");
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), [shape.settlement]);
    // Exactly one terminal transition by the owner, and the row agrees.
    assert.deepEqual(terminals.map((t) => t.status), [shape.terminal]);
    assert.equal(row?.status, shape.terminal);
    assert.equal(world.messages.length, shape.saved ? 1 : 0);
    const trailer = parseChatStreamTrailer(splitSearchMetadataTrailer(body).searchMetadataJson);
    assert.deepEqual((trailer?.artifacts ?? []).map((card) => card.status), shape.cards);
    assert.deepEqual(world.artifactRows.map((r) => r.status), shape.cards);
    assert.equal(world.discarded, 0);
  });
}
