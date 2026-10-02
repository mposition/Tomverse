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
// The provider-only fake for the ART-FORMAT-01 tests, which drive the real SDK.
import { MockLanguageModelV4 } from "ai/test";

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
  /** Parsed SDK frames, including invalid tool-call and following tool-error. */
  chunks?: unknown[];
  /** Hostile callback envelopes, before ordinary parsed frames. */
  chunkEvents?: unknown[];
  /** Hostile execution-start envelopes, before ordinary execute events. */
  executionStartEvents?: unknown[];
  /** Which of those the SDK then actually executes. */
  executes: string[];
  executeInput?: unknown;
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
        for (const event of script.chunkEvents ?? []) {
          onChunk?.(event as { chunk: unknown });
        }
        for (const chunk of script.chunks ?? []) onChunk?.({ chunk });
        for (const event of script.executionStartEvents ?? []) {
          onToolExecutionStart?.(event as { toolCall: { toolCallId: string; toolName: string } });
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
            script.executeInput ?? {
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
      selectedModels: JSON.stringify([MODEL_ID, REASONING_MODEL_ID, "mistral-small-4"]),
      kind: "chat",
    }),
    findFirst: () => ({
      id: CONVERSATION_ID,
      userId: USER_ID,
      password: null,
      selectedModels: JSON.stringify([MODEL_ID, REASONING_MODEL_ID, "mistral-small-4"]),
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

/*
  Auto's decision, forced (CHAT-ART-01).

  The real selection routes only a conversation in `auto` mode, inside the
  cohort, past the readiness gates -- none of which is this contract. So the
  selection is replaced by one that answers exactly what the real one answers
  (every existing test above leaves `forcedAutoRoute` null and gets the real
  decision), and a test that needs a routed turn names the model Auto chose.
  What is under test is everything after the decision: that the tools, the
  system block and the card follow the model that will actually answer.
*/
const realAutoSelection = require(resolve(ROOT, "lib/autoModelSelection.ts")) as {
  selectAutoModel: (input: unknown) => unknown;
};
const { ROUTER_VERSIONS } = require(resolve(ROOT, "lib/routerDecision.ts")) as {
  ROUTER_VERSIONS: unknown;
};

let forcedAutoRoute: string | null = null;

const routedSelection = (modelId: string) => ({
  routed: true,
  modelId,
  sticky: { modelId, turnsFavouringChallenger: 0 },
  fallbackCandidateModelIds: [],
  versions: ROUTER_VERSIONS,
  cohort: { eligible: true, bucket: 0, version: "test", salt: "test" },
  record: {
    versions: ROUTER_VERSIONS,
    taskKind: "writing",
    taskConfidence: "high",
    needsCurrentInformation: false,
    expectedOutputLength: "medium",
    scripts: [],
    signals: [],
    reservedInputTokens: 0,
    requestOutputCapTokens: 0,
    consideredModelCount: 1,
    eligibleModelIds: [modelId],
    rejections: [],
    selectedModelId: modelId,
    selectionReason: "only_candidate",
    selectionMargin: 0,
    selectionDecidedBy: null,
    challengerModelId: null,
    turnsFavouringChallenger: 0,
    decisionLatencyMs: 0,
  },
});

mock.module(mod("lib/autoModelSelection.ts"), {
  namedExports: {
    ...realAutoSelection,
    selectAutoModel: (input: unknown) =>
      forcedAutoRoute
        ? routedSelection(forcedAutoRoute)
        : realAutoSelection.selectAutoModel(input),
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

// Nothing here may reach a provider or any other network endpoint.
let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  return new Response(null, { status: 204 });
}) as typeof fetch;

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
  {
    modelId = MODEL_ID,
    autoRoutedTo = null,
  }: { modelId?: string; autoRoutedTo?: string | null } = {}
) => {
  forcedAutoRoute = autoRoutedTo;
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
  networkCalls = 0;

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

const captureArtifactRejections = async <T>(run: () => Promise<T>) => {
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg === "string" && arg.includes('"event":"generated_artifact_tool_rejected"')) {
        lines.push(arg);
      }
    }
  };
  let result: T;
  try {
    result = await run();
  } finally {
    console.warn = originalWarn;
  }
  return {
    result,
    logs: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
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

test("SDK-invalid artifact call logs safe rejection metadata without executing a tool", async () => {
  const secret = "SECRET_ARTIFACT_INPUT";
  const { logs, result: { trailer } } = await captureArtifactRejections(() =>
    ask({
      begins: [{ toolCallId: "invalid_1", toolName: "create_text_file" }],
      chunks: [
        {
          type: "tool-call", invalid: true, toolCallId: "invalid_1",
          toolName: "create_text_file",
          input: { format: "txt", filename: secret, content: secret },
          error: new Error(secret),
        },
        {
          type: "tool-error", toolCallId: "invalid_1",
          toolName: "create_text_file", error: secret,
        },
      ],
      executes: [],
    })
  );
  assert.deepEqual(logs, [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "input_schema_rejected",
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET_ARTIFACT_INPUT|invalid_1/);
  assert.equal(trailer?.artifacts, undefined);
  assert.deepEqual(world.artifactRows, []);
  assert.equal(networkCalls, 0);
});

test("a hostile chunk does not prevent the route from logging a later invalid call", async () => {
  const hostile = new Proxy({}, {
    get() { throw new Error("hostile chunk getter"); },
  });
  const hostileEnvelope = {
    get chunk() { throw new Error("hostile callback getter"); },
  };
  const { logs, result: { trailer } } = await captureArtifactRejections(() =>
    ask({
      chunkEvents: [hostileEnvelope],
      chunks: [hostile, {
        type: "tool-call", invalid: true, toolCallId: "invalid_after_hostile",
        toolName: "create_text_file", input: { format: "txt" },
      }],
      executes: [],
    })
  );

  assert.deepEqual(logs, [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "input_schema_rejected",
  }]);
  assert.equal(trailer?.artifacts, undefined);
  assert.equal(networkCalls, 0);
});

test("collector admission logs wrong-kind txt without duplicating the failed card", async () => {
  const { logs, result: { trailer } } = await captureArtifactRejections(() =>
    ask({
      begins: [{ toolCallId: "collector_1", toolName: "create_text_file" }],
      executes: ["collector_1"],
      executeInput: {
        format: "txt", filename: "SECRET_FILENAME", content: "SECRET_CONTENT",
      },
    })
  );
  assert.deepEqual(logs, [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "spec_rejected",
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET_/);
  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]?.failureCode, "spec_rejected");
  assert.equal(networkCalls, 0);
});

test("valid artifact execution emits no rejection diagnostic", async () => {
  const { logs } = await captureArtifactRejections(() =>
    ask({ begins: [beganTextFile], executes: [beganTextFile.toolCallId] })
  );
  assert.deepEqual(logs, []);
  assert.equal(world.artifactRows[0]?.status, "ready");
  assert.equal(networkCalls, 0);
});

test("hostile execution-start getters do not abort an otherwise valid artifact turn", async () => {
  const hostileToolCall = {
    get toolCall() { throw new Error("hostile toolCall getter"); },
  };
  const hostileCallId = {
    toolCall: { get toolCallId() { throw new Error("hostile toolCallId getter"); } },
  };
  const { logs, result: { trailer } } = await captureArtifactRejections(() =>
    ask({
      begins: [beganTextFile],
      executionStartEvents: [hostileToolCall, hostileCallId],
      executes: [beganTextFile.toolCallId],
    })
  );
  assert.deepEqual(logs, []);
  assert.equal(trailer?.artifacts?.[0]?.status, "ready");
  assert.equal(world.artifactRows[0]?.status, "ready");
  assert.equal(networkCalls, 0);
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

/* -------------------------------------------------------------------------- */
/* Auto chose the model (CHAT-ART-01)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A model with no verified artifact tool support that every plan can select,
 * and no reasoning setting, so nothing else about the turn changes with it.
 */
const UNVERIFIED_MODEL_ID = "mistral-small-4";

/** The words the provider receives outside the tool definitions. */
const promptText = () =>
  JSON.stringify(lastStreamTextOptions ?? {}, (key, value) =>
    key === "tools" ? undefined : value
  );

test("Auto routing to a verified model registers the file tools for that model", async () => {
  // The user's own model is one the tools are off for. If the plan read the
  // requested model instead of the routed one, no tool would be registered.
  const { trailer } = await ask(
    {
      begins: [beganTextFile],
      executes: [beganTextFile.toolCallId],
      finishReason: "stop",
      rawFinishReason: "end_turn",
    },
    { modelId: UNVERIFIED_MODEL_ID, autoRoutedTo: MODEL_ID }
  );

  const tools = lastStreamTextOptions!.tools as Record<string, unknown>;
  assert.ok(tools.create_text_file, "the routed model's file tool was not registered");
  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]!.status, "ready");
  // The card and its row name the model that made the file.
  assert.equal(trailer?.artifacts?.[0]!.modelId, MODEL_ID);
  assert.equal(world.artifactRows[0]!.modelId, MODEL_ID);
});

test("Auto routing to an unverified model registers no file tool and says Auto chose it", async () => {
  await ask({}, { modelId: MODEL_ID, autoRoutedTo: UNVERIFIED_MODEL_ID });

  const tools = (lastStreamTextOptions!.tools ?? {}) as Record<string, unknown>;
  for (const name of [
    "create_text_file",
    "create_document",
    "create_spreadsheet",
    "create_presentation",
    "create_archive",
  ]) {
    assert.equal(tools[name], undefined, `${name} was registered for an unverified model`);
  }
  // The remedy names what the user can actually change: Auto made this
  // choice, so "choose a different model" alone would point at a picker the
  // user did not use.
  assert.match(promptText(), /instead of Auto/);
  assert.deepEqual(world.artifactRows, []);
});

test("a manual turn on an unverified model keeps the plain remedy, with no mention of Auto", async () => {
  await ask({}, { modelId: UNVERIFIED_MODEL_ID });

  const tools = (lastStreamTextOptions!.tools ?? {}) as Record<string, unknown>;
  assert.equal(tools.create_text_file, undefined);
  assert.match(promptText(), /choosing a different model/);
  assert.doesNotMatch(promptText(), /instead of Auto/);
});

/* -------------------------------------------------------------------------- */
/* ART-FORMAT-01: a .txt request answered with "txt is not supported"           */
/* -------------------------------------------------------------------------- */

/*
  Reported on staging: a user asked for a short memo as a .txt file, the
  answer said .txt was not supported, tried Markdown, and delivered a .docx.
  The logs held one `generated_artifact_created` (docx) and nothing about the
  calls before it.

  The format table puts `txt` and `md` in the `document` kind, so they are made
  by `create_document`; `create_text_file`'s `format` enum does not list them.
  The unconfirmed hypothesis is that the model called `create_text_file` with
  `txt`, then `md`, was refused both times by a message that never named the
  right tool, and fell back to a format it could make -- the substitution
  docs/policy/generated-artifacts.md section 4 forbids ("the format the user
  names is the format you produce").

  These tests pin what the application does on each step of that path. They do
  not choose the fix. The one test that states the outcome a fix must reach is
  marked `todo` (expected to fail) and passes under any of the candidate fixes.

  The existing tests above feed the route hand-written invalid frames. The
  ones below take the frames from the REAL SDK validating the REAL registered
  tool, which is the only way to show which refusal channel production
  actually takes: the SDK checks `inputSchema` before `execute`, so a `txt`
  call to `create_text_file` never reaches the collector's own admission.
*/


type RegisteredTool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, meta: unknown) => unknown;
};

/** The artifact tools exactly as the route registers them for a verified model. */
const registeredArtifactTools = async (): Promise<Record<string, RegisteredTool>> => {
  await ask({});
  assert.ok(lastStreamTextOptions, "streamText was never called");
  return lastStreamTextOptions!.tools as Record<string, RegisteredTool>;
};

/**
 * One provider tool call run through the real SDK against a registered tool.
 *
 * Only the provider is fake. The schema check, the invalid-call frame and the
 * error text are the SDK's own, so what comes back is what a real turn would
 * hand both the route's `onChunk` and the model's next step.
 */
const callThroughRealSdk = async (
  registered: RegisteredTool,
  toolName: string,
  input: Record<string, unknown>
) => {
  const chunks: Array<Record<string, unknown>> = [];
  let executions = 0;
  const model = new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: `sdk_${toolName}_${String(input.format)}`,
            toolName,
            input: JSON.stringify(input),
          });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    },
  });
  const result = aiModule.streamText({
    model,
    prompt: "fixture",
    tools: {
      [toolName]: {
        ...registered,
        // Counted, then forwarded: the schema stays the registered one.
        execute: async (toolInput: unknown, meta: unknown) => {
          executions += 1;
          return registered.execute?.(toolInput, meta);
        },
      } as never,
    },
    onChunk: ({ chunk }) => {
      chunks.push(chunk as Record<string, unknown>);
    },
  });
  for await (const part of result.fullStream) assert.ok(part);

  const invalidCalls = chunks.filter(
    (chunk) => chunk.type === "tool-call" && chunk.invalid === true
  );
  const toolErrors = chunks.filter((chunk) => chunk.type === "tool-error");
  const refusalText = toolErrors
    .map((chunk) => {
      const error = chunk.error as { message?: unknown } | string | undefined;
      return typeof error === "string" ? error : String(error?.message ?? "");
    })
    .join("\n");
  return { chunks, executions, invalidCalls, toolErrors, refusalText };
};

test("ART-FORMAT-01 (a): a .txt request made through create_document is delivered as a ready .txt file", async () => {
  const { logs, result: { trailer } } = await captureArtifactRejections(() =>
    ask({
      begins: [{ toolCallId: "doc_txt", toolName: "create_document" }],
      executes: ["doc_txt"],
      executeInput: {
        filename: "memo.txt",
        format: "txt",
        title: "Memo",
        blocks: [{ type: "paragraph", text: "Team lunch moves to Friday." }],
      },
    })
  );

  assert.deepEqual(logs, [], "a valid txt document must not log a rejection");
  assert.equal(world.artifactRows.length, 1);
  assert.equal(world.artifactRows[0]?.format, "txt");
  assert.equal(world.artifactRows[0]?.status, "ready");
  assert.match(world.artifactRows[0]?.filename ?? "", /\.txt$/);
  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]?.format, "txt");
  assert.equal(trailer?.artifacts?.[0]?.status, "ready");
  assert.equal(networkCalls, 0);
});

test("ART-FORMAT-01 (b, c): the real SDK refuses txt and md for create_text_file before execute, the route logs each refusal, and nothing is produced in their place", async () => {
  const secret = "SECRET_ART_FORMAT_01";

  for (const format of ["txt", "md"]) {
    const tools = await registeredArtifactTools();
    assert.ok(tools.create_text_file, "the text-file tool was not registered");

    const sdk = await callThroughRealSdk(tools.create_text_file, "create_text_file", {
      filename: `${secret}.${format}`,
      format,
      content: secret,
    });

    // Production takes the SDK channel, not the collector's admission: the
    // registered schema is checked first and execute never runs.
    assert.equal(sdk.executions, 0, `${format}: execute ran for a refused call`);
    assert.equal(sdk.invalidCalls.length, 1, `${format}: expected one invalid tool-call frame`);
    assert.equal(sdk.toolErrors.length, 1, `${format}: expected one tool-error frame`);

    // Those exact frames, through the route's own onChunk.
    const { logs, result: { trailer } } = await captureArtifactRejections(() =>
      ask({ chunks: sdk.chunks, executes: [] })
    );

    assert.deepEqual(logs, [{
      event: "generated_artifact_tool_rejected",
      toolName: "create_text_file",
      requestedFormat: format,
      rejectionCode: "input_schema_rejected",
    }], `${format}: the route did not log the SDK refusal exactly once`);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));

    // (c) The application substitutes nothing: no row and no card of any
    // format. Whatever the user receives next is a new model decision, and
    // it is a new, separately logged call.
    assert.deepEqual(world.artifactRows, [], `${format}: a refused call produced a file`);
    assert.equal(trailer?.artifacts, undefined, `${format}: a refused call produced a card`);
    assert.equal(networkCalls, 0);
  }
});

/*
  EXPECTED TO FAIL until a fix is chosen -- the outcome, not the fix.

  A `txt` call that reaches `create_text_file` must leave the model a way to a
  .txt file. Any ONE of the candidate fixes satisfies this test, and it does
  not prefer between them:

    A. `create_text_file` accepts `txt` (and `md`);
    B. the refusal the model receives names `create_document`;
    C. the `create_text_file` description tells the model that `txt` and `md`
       belong to `create_document`.

  Today none holds: the SDK's refusal is a bare enum error, and the
  description lists only source, markup and config formats. The artifact
  system block does place txt and md under `create_document`, and the staging
  turn went to `create_text_file` regardless, so that line alone is not
  counted here.

  Whoever lands a fix removes `todo` so this becomes a regression test.
*/
test(
  "ART-FORMAT-01 (outcome): a txt call to create_text_file leaves the model a route to a .txt file",
  { todo: "fix undecided (ART-FORMAT-01): accept txt/md, name create_document in the refusal, or say so in the tool description" },
  async () => {
    const tools = await registeredArtifactTools();
    const textTool = tools.create_text_file;
    assert.ok(textTool, "the text-file tool was not registered");

    const sdk = await callThroughRealSdk(textTool, "create_text_file", {
      filename: "memo.txt",
      format: "txt",
      content: "Team lunch moves to Friday.",
    });

    const accepted = sdk.invalidCalls.length === 0 && sdk.executions === 1;
    const refusalNamesDocumentTool = /\bcreate_document\b/.test(sdk.refusalText);
    const descriptionNamesDocumentTool = /\bcreate_document\b/.test(textTool.description ?? "");

    assert.ok(
      accepted || refusalNamesDocumentTool || descriptionNamesDocumentTool,
      "no route to a .txt file: create_text_file refused txt " +
        `(accepted=${accepted}), the refusal did not name create_document ` +
        `(refusal=${JSON.stringify(sdk.refusalText.slice(0, 600))}), and the ` +
        "tool description does not either"
    );
  }
);
