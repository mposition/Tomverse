import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/*
  The real `ai`, imported statically rather than through `createRequire`.

  Everything but `streamText` is passed through, and the passthrough has to be
  complete: `lib/generatedArtifactTool.ts` imports `tool` and the route imports
  `stepCountIs`, so a namespace missing either one leaves the route unable to
  link -- which surfaces as a module with no `POST`, not as an import error.
  A static import is the only form guaranteed to yield the module's whole
  export list on every runtime.
*/
import * as aiModule from "ai";

/**
 * What POST /api/chat leaves behind when a file was begun and the answer ran
 * out of room.
 *
 * docs/policy/generated-artifacts.md sections 1, 5 and 9.
 *
 * The reported turn: Claude Haiku 4.5 was asked to turn a deck into a web
 * page, wrote "이제 웹페이지를 만들겠습니다:", started a `create_text_file`
 * call, and hit its output ceiling while it was still writing the input. The
 * tool never ran, so the collector recorded nothing, so the answer ended with
 * a generic length notice and no card -- the app had said it was about to make
 * a file and then said nothing at all, which is the one thing section 1
 * forbids.
 *
 * `tests/generatedArtifactTurnTracker.test.mjs` and
 * `tests/generatedArtifactIncompleteTurn.test.mjs` pin the tracker and the
 * collector on their own. What only the route can show is the join: that the
 * SDK's lifecycle callbacks are actually wired, that the card reaches the
 * stream trailer, and that the row goes down in the assistant message's own
 * transaction.
 *
 * Two seams are replaced with fakes and the rest of the handler is real: the
 * provider stream, and the database. The database fake is permissive by
 * design -- what is being asserted is the artifact rows the route writes, not
 * the ledger, and a fake that answered only the queries this test predicted
 * would fail for reasons that are not this contract.
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

/** Verified for tool use, available to every plan, and the reported model. */
const MODEL_ID = "claude-haiku-4-5";
/**
 * A verified model that also carries a reasoning setting.
 *
 * Used by the provider-context test alone: `MessageProviderContext` is only
 * written for a reasoning model, so asserting its absence on a model that
 * never writes one would assert nothing.
 */
const REASONING_MODEL_ID = "gpt-5-6-luna";
const USER_ID = "artifact-user-1";
const CONVERSATION_ID = "artifact-conversation-1";
const ASSISTANT_MESSAGE_ID = "11111111-2222-4333-8444-555555555555";
const ANSWER = "이 자료를 바탕으로 웹페이지를 만들겠습니다:";

/* -------------------------------------------------------------------------- */
/* The provider stream this turn gets                                           */
/* -------------------------------------------------------------------------- */

type StreamScript = {
  /** Tool calls the provider begins, as `tool-input-start` frames. */
  begins: Array<{ toolCallId: string; toolName: string; providerExecuted?: boolean }>;
  /** Which of those the SDK then actually executes. */
  executes: string[];
  finishReason: string;
  rawFinishReason: string;
  text: string;
};

let script: StreamScript = {
  begins: [],
  executes: [],
  finishReason: "stop",
  rawFinishReason: "end_turn",
  text: ANSWER,
};

let lastStreamTextOptions: Record<string, unknown> | null = null;

type ArtifactRow = {
  messageId: string;
  ordinal: number;
  format: string;
  filename: string;
  status: string;
  objectKey: string | null;
  failureCode?: string;
  modelId: string | null;
};

const world = {
  artifactRows: [] as ArtifactRow[],
  messages: [] as Array<{ id: string; status: string; modelId: string }>,
  providerContexts: [] as Array<{ messageId: string }>,
};

mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => ({
      user: { id: USER_ID, email: "artifact-qa@tomverse.app" },
    }),
  },
});

/*
  Only `streamText` is replaced; the rest of `ai` is spread back in because
  the route uses `tool()` and `stepCountIs()` to register the artifact tools,
  and a mock that dropped them would fail the turn for a reason that has
  nothing to do with this contract.

  The fake drives the same callbacks the SDK does, in the same order: the
  begin frames through `onChunk`, then the executions through
  `onToolExecutionStart` *and* the tool's own `execute`, which is what the two
  redundant signals mean in practice.
*/
mock.module("ai", {
  namedExports: {
    ...aiModule,
    streamText: (options: Record<string, unknown>) => {
      lastStreamTextOptions = options;
      const onChunk = options.onChunk as
        | ((event: { chunk: unknown }) => void)
        | undefined;
      const onToolExecutionStart = options.onToolExecutionStart as
        | ((event: { toolCall: { toolCallId: string; toolName: string } }) => void)
        | undefined;
      const tools = (options.tools ?? {}) as Record<
        string,
        { execute?: (input: unknown, meta: { toolCallId: string }) => unknown }
      >;

      const drive = async () => {
        for (const begin of script.begins) {
          onChunk?.({ chunk: { type: "tool-input-start", ...begin } });
          // The delta frames a real provider sends in between are omitted on
          // purpose: nothing in this feature may read a partial tool input.
        }
        for (const toolCallId of script.executes) {
          const begin = script.begins.find(
            (candidate) => candidate.toolCallId === toolCallId
          );
          if (!begin) continue;
          onToolExecutionStart?.({
            toolCall: { toolCallId, toolName: begin.toolName },
          });
          await tools[begin.toolName]?.execute?.(
            {
              filename: "generated-report.html",
              format: "html",
              content: "<!doctype html><title>ok</title><p>ok</p>",
            },
            { toolCallId }
          );
        }
      };

      const driven = drive();

      return {
        textStream: new ReadableStream<string>({
          async start(controller) {
            await driven;
            controller.enqueue(script.text);
            controller.close();
          },
        }),
        response: Promise.resolve({
          id: "resp-artifact-1",
          modelId: MODEL_ID,
          headers: {},
          messages: [],
        }),
        usage: Promise.resolve({
          inputTokens: 1_000,
          outputTokens: 500,
          cachedInputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
        }),
        finishReason: Promise.resolve(script.finishReason),
        rawFinishReason: Promise.resolve(script.rawFinishReason),
        content: Promise.resolve([]),
        providerMetadata: Promise.resolve({}),
      };
    },
  },
});

/* -------------------------------------------------------------------------- */
/* The database this turn writes to                                             */
/* -------------------------------------------------------------------------- */

/**
 * A permissive Prisma stand-in.
 *
 * Every model answers with the empty-ish shape its verb implies, and the four
 * calls this contract is actually about are overridden. The alternative --
 * enumerating every query the handler makes on the way past -- would break
 * whenever an unrelated part of the turn learned to read one more row, and
 * this test would then be failing about something it does not test.
 */
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

const OVERRIDES: Record<string, Record<string, (args: never) => unknown>> = {
  conversation: {
    findUnique: () => ({
      id: CONVERSATION_ID,
      userId: USER_ID,
      password: null,
      selectedModels: JSON.stringify([MODEL_ID, REASONING_MODEL_ID]),
      kind: "chat",
    }),
    findFirst: () => ({
      id: CONVERSATION_ID,
      userId: USER_ID,
      password: null,
      selectedModels: JSON.stringify([MODEL_ID, REASONING_MODEL_ID]),
      kind: "chat",
    }),
  },
  message: {
    findFirst: () => ({ id: "user-message-1" }),
    create: (args: { data: { id: string; status: string; modelId: string } }) => {
      world.messages.push({
        id: args.data.id,
        status: args.data.status,
        modelId: args.data.modelId,
      });
      return args.data;
    },
  },
  messageProviderContext: {
    create: (args: { data: { messageId: string } }) => {
      world.providerContexts.push({ messageId: args.data.messageId });
      return args.data;
    },
  },
  messageArtifact: {
    createMany: (args: { data: ArtifactRow[] }) => {
      world.artifactRows.push(...args.data);
      return { count: args.data.length };
    },
    // Read back by the route so a failed card gets its own row's id, which is
    // what makes the card survive a reload.
    findMany: () =>
      world.artifactRows.map((row, index) => ({
        id: `row_${index + 1}`,
        ordinal: row.ordinal,
      })),
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
        return async (args: never) =>
          override ? override(args) : fallback!();
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

/*
  `lib/prisma.ts` exports `prisma` and nothing else, so that is the whole of
  what the mock may declare. Adding a `default` here would describe a module
  the application does not have, and a synthetic module whose export list
  disagrees with its importers is a link failure -- which reaches a test as a
  namespace missing the export it came for, never as an error naming the
  cause.
*/
mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma: prismaProxy },
});

/* -------------------------------------------------------------------------- */
/* The seams that cost money, neutralised rather than exercised                 */
/* -------------------------------------------------------------------------- */

const realChatSecurity = require(resolve(ROOT, "lib/chatSecurity.ts")) as Record<
  string,
  unknown
>;

const reservation = {
  reservationId: "reservation-1",
  userId: USER_ID,
  traceId: "trace-artifact-1",
  source: "chat" as const,
  modelId: MODEL_ID,
  provider: "anthropic" as const,
  entries: [],
};

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => ({
      leaseId: "lease-1",
      setCookie: undefined,
      usageReservation: reservation,
    }),
    releaseChatAccess: async () => undefined,
    heartbeatChatAccess: async () => undefined,
    settleChatUsage: async () => undefined,
    linkChatReservationProviderRequest: async () => undefined,
    reserveAttemptProviderBudget: async () => ({ ok: true, entries: [] }),
    releaseAttemptProviderBudget: async () => undefined,
  },
});

// Constructing a provider client reads API keys and is not what is under test.
mock.module(mod("lib/activeAiModel.ts"), {
  namedExports: { getActiveAiModel: () => ({ modelId: MODEL_ID }) },
});

/*
  The object store: an artifact that succeeds must not reach a real bucket.

  The three exports the chat turn actually reaches are named rather than
  spread from the real module, for the reason above -- a mock's export list is
  a claim about the module, and the narrowest true claim is the one that
  cannot drift.
*/
const realArtifactStorage = require(
  resolve(ROOT, "lib/generatedArtifactStorage.ts")
) as { persistArtifactRows: unknown };

mock.module(mod("lib/generatedArtifactStorage.ts"), {
  namedExports: {
    persistArtifactRows: realArtifactStorage.persistArtifactRows,
    putArtifactObject: async (input: {
      ordinal: number;
      format: string;
      filename: string;
      mediaType: string;
      bytes: Uint8Array;
      modelId: string | null;
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
    discardStoredArtifacts: async () => undefined,
  },
});

// Nothing here may reach the network.
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

/* -------------------------------------------------------------------------- */
/* Driving the route                                                            */
/* -------------------------------------------------------------------------- */

type RouteModule = { POST: (request: Request) => Promise<Response> };

/**
 * The route handler, imported once.
 *
 * No query suffix: the neighbouring suites carry one to name their own spy
 * generation, tsx normalises it away regardless, and this file wants the one
 * shared instance rather than a fresh one. Memoised so a failure to load is
 * reported once instead of once per test.
 *
 * The `POST` check is not defensive padding. A mocked module whose declared
 * export list disagrees with its importers does not throw -- the graph fails
 * to link and the namespace simply arrives without what it was imported for.
 * Read raw, that reaches the assertions as `POST is not a function`, which
 * names neither the module at fault nor the export that went missing.
 */
let routePromise: Promise<RouteModule> | null = null;

const loadRoute = async (): Promise<RouteModule> => {
  routePromise ??= (async () => {
    // The mocked `ai`, checked before the route rather than after it. The
    // route and `lib/generatedArtifactTool.ts` link against `stepCountIs` and
    // `tool`; if the passthrough above ever fails to carry them, this names
    // the cause instead of leaving the route to fail for it.
    const ai = (await import("ai")) as Record<string, unknown>;
    for (const name of ["tool", "stepCountIs", "streamText"]) {
      assert.equal(
        typeof ai[name],
        "function",
        `the mocked \`ai\` module lost \`${name}\`, so the route cannot link`
      );
    }
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

const ask = async (
  next: Partial<StreamScript>,
  { modelId = MODEL_ID }: { modelId?: string } = {}
) => {
  script = {
    begins: [],
    executes: [],
    finishReason: "stop",
    rawFinishReason: "end_turn",
    text: ANSWER,
    ...next,
  };
  world.artifactRows = [];
  world.messages = [];
  world.providerContexts = [];
  lastStreamTextOptions = null;

  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "이 PPT를 웹페이지로 만들어줘" }],
        modelId,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
      }),
    })
  );
  if (response.status !== 200) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  const body = await response.text();
  return { body, trailer: readTrailer(body) };
};

/**
 * The trailer, read the way the browser reads it.
 *
 * Parsed with the real parser rather than a hand-written regular expression,
 * so a change to the wire format breaks this test instead of slipping past it.
 */
type ParsedTrailer = {
  artifacts?: Array<{
    id: string;
    ordinal: number;
    format: string;
    filename: string;
    status: string;
    failureCode?: string;
    modelId?: string;
  }>;
  completion?: { status: string; incompleteReason?: string };
} | null;

const { parseChatStreamTrailer, splitSearchMetadataTrailer } = require(
  resolve(ROOT, "lib/webSearchStreamTrailer.ts")
) as {
  parseChatStreamTrailer: (json: string | null) => ParsedTrailer;
  splitSearchMetadataTrailer: (raw: string) => {
    displayText: string;
    searchMetadataJson: string | null;
  };
};

const readTrailer = (body: string): ParsedTrailer =>
  parseChatStreamTrailer(splitSearchMetadataTrailer(body).searchMetadataJson);

const beganTextFile = {
  toolCallId: "call_html",
  toolName: "create_text_file",
};

/* -------------------------------------------------------------------------- */
/* The contract                                                                 */
/* -------------------------------------------------------------------------- */

test("the route wires both lifecycle signals when it registers the artifact tools", async () => {
  await ask({});
  assert.ok(lastStreamTextOptions, "streamText was never called");
  assert.equal(typeof lastStreamTextOptions!.onChunk, "function");
  assert.equal(typeof lastStreamTextOptions!.onToolExecutionStart, "function");
  const tools = lastStreamTextOptions!.tools as Record<string, unknown>;
  assert.ok(tools.create_text_file, "the text-file tool was not registered");
});

test("a tool call begun and cut off by the output ceiling becomes a turn_incomplete card", async () => {
  const { trailer } = await ask({
    begins: [beganTextFile],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.equal(trailer?.completion?.status, "incomplete");
  assert.equal(trailer?.completion?.incompleteReason, "length");
  assert.equal(trailer?.artifacts?.length, 1);
  const [card] = trailer!.artifacts!;
  assert.equal(card.status, "failed");
  assert.equal(card.failureCode, "turn_incomplete");
  // Labelled from the tool's kind, because the model never finished naming a
  // format or a filename and neither is read from a partial input.
  assert.equal(card.format, "txt");
  assert.equal(card.filename, "generated.txt");
  assert.equal(card.modelId, MODEL_ID);
});

test("the card's row is written in the assistant message's own transaction", async () => {
  await ask({
    begins: [beganTextFile],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.deepEqual(
    world.messages.map((message) => [message.id, message.status]),
    [[ASSISTANT_MESSAGE_ID, "incomplete"]]
  );
  assert.equal(world.artifactRows.length, 1);
  const [row] = world.artifactRows;
  assert.equal(row.messageId, ASSISTANT_MESSAGE_ID);
  assert.equal(row.ordinal, 0);
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "turn_incomplete");
  assert.equal(row.modelId, MODEL_ID);
  // The migration's CHECK requires it, and there is no object to point at.
  assert.equal(row.objectKey, null);
});

test("the card the browser sees carries the row's own id, so a reload finds it", async () => {
  const { trailer } = await ask({
    begins: [beganTextFile],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.equal(trailer?.artifacts?.[0]!.id, "row_1");
  assert.ok(
    !trailer!.artifacts![0]!.id.startsWith("pending:"),
    "the card kept the synthetic id it streamed with"
  );
});

test("a truncated turn stores no provider context, so no half-written tool call is replayed", async () => {
  // `MessageProviderContext` replays a reasoning model's own response messages
  // on a later turn. A turn cut off mid tool call has a `tool_use` in those
  // messages that the provider never finished writing, and replaying one is a
  // request the provider rejects outright.
  const truncated = { finishReason: "length", rawFinishReason: "max_tokens" };

  await ask(
    { ...truncated, begins: [], executes: [] },
    { modelId: REASONING_MODEL_ID }
  );
  assert.equal(
    world.providerContexts.length,
    1,
    "a reasoning model with no tool call should still store its context -- otherwise the assertion below proves nothing"
  );

  await ask(
    { ...truncated, begins: [beganTextFile], executes: [] },
    { modelId: REASONING_MODEL_ID }
  );
  assert.deepEqual(world.providerContexts, []);
});

/* -------------------------------------------------------------------------- */
/* What must stay exactly as it is                                              */
/* -------------------------------------------------------------------------- */

test("an ordinary length-truncated answer with no tool call gets no card", async () => {
  const { trailer } = await ask({
    begins: [],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.equal(trailer?.completion?.status, "incomplete");
  // The key is absent, not empty: an older client ignores what it does not
  // know, and a turn that made nothing says nothing.
  assert.equal(trailer?.artifacts, undefined);
  assert.deepEqual(world.artifactRows, []);
});

test("a tool call that ran keeps its own single card, with no turn_incomplete beside it", async () => {
  const { trailer } = await ask({
    begins: [beganTextFile],
    executes: [beganTextFile.toolCallId],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]!.status, "ready");
  assert.equal(trailer?.artifacts?.[0]!.failureCode, undefined);
  assert.equal(world.artifactRows.length, 1);
  assert.equal(world.artifactRows[0]!.status, "ready");
});

test("a turn that finished normally records nothing extra", async () => {
  const { trailer } = await ask({
    begins: [beganTextFile],
    executes: [beganTextFile.toolCallId],
    finishReason: "stop",
    rawFinishReason: "end_turn",
  });

  assert.equal(trailer?.completion?.status, "normal");
  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]!.status, "ready");
});

test("a native search tool cut off by the same ceiling is not a missing file", async () => {
  const { trailer } = await ask({
    begins: [
      { toolCallId: "call_search", toolName: "web_search", providerExecuted: true },
      { toolCallId: "call_search_2", toolName: "web_search" },
    ],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.equal(trailer?.completion?.status, "incomplete");
  assert.equal(trailer?.artifacts, undefined);
  assert.deepEqual(world.artifactRows, []);
});

test("more begun calls than an answer may attach still yields at most three cards", async () => {
  const { trailer } = await ask({
    begins: [
      { toolCallId: "call_1", toolName: "create_text_file" },
      { toolCallId: "call_2", toolName: "create_document" },
      { toolCallId: "call_3", toolName: "create_spreadsheet" },
      { toolCallId: "call_4", toolName: "create_presentation" },
    ],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });

  assert.equal(trailer?.artifacts?.length, 3);
  assert.deepEqual(
    trailer!.artifacts!.map((artifact) => artifact.ordinal),
    [0, 1, 2]
  );
  assert.equal(world.artifactRows.length, 3);
});
