import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { renderDocumentDocx } from "../../lib/generatedArtifactDocx";
import { renderPresentationPptx } from "../../lib/generatedArtifactPptx";
import { renderWorkbook } from "../../lib/generatedArtifactXlsx";
import { admitWorkbookSpecSafely } from "../../lib/generatedArtifactCore";
import { canonicalWorkbookSpecFor } from "../../lib/generatedArtifactWorkbookRevision";
import { CHAT_ATTACHMENT_PARSE_CHARACTERS } from "../../lib/chatAttachmentLimits";

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
  /** The provider stream breaks with this after `text`, instead of closing. */
  failAfterText?: unknown;
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
  parentArtifactId?: string | null;
  lineageId?: string | null;
};

const world = {
  artifactRows: [] as ArtifactRow[],
  messages: [] as Array<{ id: string; status: string; modelId: string; content?: string }>,
  /** The outcome each settlement was asked for, in order. */
  settlements: [] as string[],
  /** How many stored objects the route handed back for reclamation. */
  discarded: 0,
  /**
   * Errors the next assistant `message.create` calls throw, in order. With
   * `landsBeforeThrow`, the row is recorded first -- a COMMIT that went
   * through on a connection that then dropped.
   */
  messageCreateFailures: [] as unknown[],
  landsBeforeThrow: false,
  messageCreateCalls: 0,
  providerContexts: [] as Array<{ messageId: string }>,
  uploads: [] as Array<{ id: string; name: string; mediaType: string; size: number; kind: string; objectKey: string;
    sourceArtifactId?: string | null; sourceLineageId?: string; sourceConversationId?: string; sourceCanonicalSpec?: unknown }>,
  inputObjects: new Map<string, Buffer>(),
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
            // Erroring here would discard the text just queued. A provider
            // stream that breaks does so after its last chunk was read.
            if (script.failAfterText) return;
            controller.close();
          },
          pull(controller) {
            if (script.failAfterText) controller.error(script.failAfterText);
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
  messageAttachmentUpload: { findMany: () => world.uploads },
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
      productKey: "chat",
      selectionMode: forcedAutoRoute ? "auto" : "manual",
    }),
  },
  message: {
    // The route's commit check reads the assistant row back; every other
    // lookup is the source prompt.
    findFirst: ((args: { where?: { id?: string; role?: string } }) =>
      args?.where?.role === "assistant"
        ? world.messages.find((message) => message.id === args.where?.id) ?? null
        : { id: "user-message-1" }) as (args: never) => unknown,
    create: (args: { data: { id: string; status: string; modelId: string; content?: string } }) => {
      world.messageCreateCalls += 1;
      const failure = world.messageCreateFailures.shift();
      if (failure && !world.landsBeforeThrow) throw failure;
      world.messages.push({
        id: args.data.id,
        status: args.data.status,
        modelId: args.data.modelId,
        content: args.data.content,
      });
      if (failure) throw failure;
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
        parentArtifactId: row.parentArtifactId ?? null,
        lineageId: row.lineageId ?? null,
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
    settleChatUsage: async (_reservation: unknown, usage: { outcome: string }) => {
      world.settlements.push(usage.outcome);
    },
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
let forcedRouterOutput: Record<string, unknown> | null = null;
let forcedImageIntent = false;
let imageIntentCalls = 0;
let imageIntentText: string | null = null;
let routerDecisionKept: boolean | null = null;
const routerCore = require(resolve(ROOT, "lib/autoLlmRouterCore.ts")) as typeof import("../../lib/autoLlmRouterCore");
const realLlmRouter = require(resolve(ROOT, "lib/autoLlmRouter.ts")) as typeof import("../../lib/autoLlmRouter");
mock.module(mod("lib/autoLlmRouter.ts"), { namedExports: {
  ...realLlmRouter,
  pickAutoModelWithLlm: async (input: Parameters<typeof realLlmRouter.pickAutoModelWithLlm>[0]) => {
    if (!forcedRouterOutput) return null;
    const candidates = routerCore.autoLlmRouterCandidates(input.eligibleModelIds, input.models,
      input.creditsByModelId, input.fileContext);
    const pick = routerCore.parseAutoLlmRouterOutput(forcedRouterOutput, candidates);
    if (typeof input.recordDecision === "function") routerDecisionKept = await input.recordDecision(pick);
    return pick;
  },
} });
const realImageIntent = require(resolve(ROOT, "lib/chatImageIntent.ts")) as typeof import("../../lib/chatImageIntent");
mock.module(mod("lib/chatImageIntent.ts"), { namedExports: {
  ...realImageIntent,
  createChatTurnImageRouting: (input: { text?: string } | null) => {
    if (input) imageIntentCalls += 1;
    imageIntentText = input?.text ?? null;
    return {
      context: undefined,
      accept: () => {},
      // Not a combined turn: nothing for the route to record here.
      combinedOutcome: () => null,
      resolve: async () => input && forcedImageIntent
        ? { image: true, prompt: "Synthetic image request.", preset: "standard", modelId: null, edit: false }
        : { image: false },
    };
  },
} });

/*
  A Prompt Refiner decision the browser held before the send. In an existing
  Auto Chat conversation the product Refiner prepares every send, so a
  follow-up such as "make it night" arrives carrying one (G4 recording,
  2026-11-15, trace 72eeb69c). Inert unless a test sends a decision.
*/
const refinerEvents: string[] = [];
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: async () => ({ explicitEnabled: false, autoEnabled: true }),
} });
mock.module(mod("lib/promptRefinerChatExecutionStore.ts"), { namedExports: {
  previewPromptRefinerChatExecution: async (input: { messages: Array<{ role: string; content: string }> }) => {
    refinerEvents.push("preview");
    return { executionMessages: input.messages.map((message, index) => index === input.messages.length - 1
      ? { ...message, content: "Refined execution prompt" } : message),
      mode: "auto" as const, provenance: { decision: "accepted" as const } };
  },
  consumePreviewedPromptRefinerChatExecution: async (_input: unknown, preview: unknown) => {
    refinerEvents.push("consume");
    return preview;
  },
} });
mock.module(mod("lib/chatDurableRecoveryAccess.ts"), { namedExports: {
  authorizeChatRecoveryScope: async () => ({ ok: true, conversationId: CONVERSATION_ID }),
} });
const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  ...realApiSecurity,
  consumeApiRateLimit: async (...args: unknown[]) => args[2] === "chat-durable-attempt"
    ? undefined
    : (realApiSecurity.consumeApiRateLimit as (...rest: unknown[]) => Promise<unknown>)(...args),
} });
const SOURCE_USER_MESSAGE_ID = "22222222-3333-4444-8555-666666666666";
const REFINER_DECISION = { suggestionId: "33333333-4444-4555-8666-777777777777",
  scopeId: "44444444-5555-4666-8777-888888888888", epoch: 1, decision: "accepted" };

const routedSelection = (modelId: string) => ({
  routed: true,
  modelId,
  sticky: { modelId, turnsFavouringChallenger: 0 },
  fallbackCandidateModelIds: [],
  candidateCreditsByModelId: { [modelId]: 1 },
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
    selectAutoModel: (input: unknown) => {
      return forcedAutoRoute
        ? routedSelection(forcedAutoRoute)
        : realAutoSelection.selectAutoModel(input);
    },
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
    discardStoredArtifacts: async (artifacts: unknown[]) => {
      world.discarded += artifacts.length;
    },
  },
});

const realR2 = require(resolve(ROOT, "lib/r2.ts")) as Record<string, unknown>;
mock.module(mod("lib/r2.ts"), { namedExports: {
  ...realR2,
  readR2Object: async (key: string) => {
    const bytes = world.inputObjects.get(key);
    assert.ok(bytes, "only local input fixture objects may be read");
    return Buffer.from(bytes);
  },
} });

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
    routerOutput = null,
    imageIntent = false,
    refinerDecision = false,
    prompt = null,
    messages = [{ role: "user", content: prompt ?? "이 PPT를 웹페이지로 만들어줘" }],
    expectedStatus = 200,
  }: { modelId?: string; autoRoutedTo?: string | null; routerOutput?: Record<string, unknown> | null; imageIntent?: boolean;
    refinerDecision?: boolean; prompt?: string | null;
    messages?: Array<{ role: string; content: string; attachments?: Array<{ uploadId: string }> }>; expectedStatus?: number } = {}
) => {
  refinerEvents.length = 0;
  forcedAutoRoute = autoRoutedTo;
  forcedRouterOutput = routerOutput;
  forcedImageIntent = imageIntent;
  imageIntentCalls = 0;
  routerDecisionKept = null;
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
  world.settlements = [];
  world.discarded = 0;
  world.messageCreateCalls = 0;
  lastStreamTextOptions = null;
  networkCalls = 0;

  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // A held Refiner decision names its source message, so the last
        // user turn carries that id.
        messages: refinerDecision
          ? messages.map((m, i) => (i === messages.length - 1 ? { ...m, id: SOURCE_USER_MESSAGE_ID } : m))
          : messages,
        modelId,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        ...(refinerDecision ? { sourceUserMessageId: SOURCE_USER_MESSAGE_ID, promptRefinerDecision: REFINER_DECISION } : {}),
      }),
    })
  );
  if (response.status !== expectedStatus) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  const mode = response.headers.get("X-Chat-Response-Mode");
  // Read chunk by chunk rather than with `text()`: a stream the route fails
  // part way still delivered what came before the break, and one test below
  // is about exactly those bytes.
  let body = "";
  let streamError: unknown = null;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (!script.failAfterText) throw error;
    streamError = error;
  }
  return { body, mode, trailer: response.status === 200 ? readTrailer(body) : null, streamError };
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
  // Auto made this choice, so the remedy is to ask again -- Auto routes a file
  // request to a model that can create files -- never "turn Auto off" or
  // "choose a model yourself", which names a choice the user did not make.
  assert.match(promptText(), /sending the same request again: Auto routes a file request/);
  assert.match(promptText(), /do not tell them to turn Auto off/);
  assert.deepEqual(world.artifactRows, []);
});

test("file intent with no capable candidate keeps the refusal in Chat despite a positive image classification", async () => {
  await ask({}, { modelId: UNVERIFIED_MODEL_ID, autoRoutedTo: UNVERIFIED_MODEL_ID,
    routerOutput: { modelId: UNVERIFIED_MODEL_ID, requiresFileGeneration: true, reason: "Deliver a document about images." },
    imageIntent: true });
  assert.equal(imageIntentCalls, 1, "the parallel image classification must actually run");
  assert.equal(routerDecisionKept, true, "a file request remains a Chat routing decision");
  assert.ok(lastStreamTextOptions, "the turn was incorrectly handed off to the image workspace");
  assert.equal((lastStreamTextOptions.tools as Record<string, unknown> | undefined)?.create_text_file, undefined);
  assert.match(promptText(), /sending the same request again: Auto routes a file request/);
  assert.match(promptText(), /do not tell them to turn Auto off/);
  assert.deepEqual(world.artifactRows, []);
});

/*
  G4 recording, 2026-11-15 (trace 72eeb69c): in an existing Auto Chat the
  product Refiner holds a decision on every send, and the route then skipped
  the image classification entirely -- "Make it night, with snow falling."
  after an image answer was answered as text.
*/
test("a follow-up that carries a held Refiner decision still gets the image classification", async () => {
  const { mode } = await ask({}, { autoRoutedTo: MODEL_ID, imageIntent: true, refinerDecision: true,
    prompt: "Make it night, with snow falling." });
  assert.equal(imageIntentCalls, 1, "the Refiner decision must not switch the image classification off");
  assert.equal(imageIntentText, "Make it night, with snow falling.",
    "the image classification reads the authored message, not the Refiner's execution text");
  assert.equal(mode, "image-turn");
  assert.equal(lastStreamTextOptions, null, "an image turn calls no chat model");
  assert.deepEqual(refinerEvents, ["preview"], "an image turn ends before the Refiner decision is consumed");
});

test("an ordinary follow-up with a held Refiner decision stays a text turn and consumes it once", async () => {
  const { mode } = await ask({}, { autoRoutedTo: MODEL_ID, refinerDecision: true, prompt: "Why is snow white?" });
  assert.equal(imageIntentCalls, 1);
  assert.notEqual(mode, "image-turn");
  assert.ok(lastStreamTextOptions, "the text turn reaches the chat model");
  assert.match(promptText(), /Refined execution prompt/, "the text turn still runs the Refiner's execution view");
  assert.deepEqual(refinerEvents, ["preview", "consume"]);
});

test("a manual turn on an unverified model keeps the plain remedy, with no mention of Auto", async () => {
  await ask({}, { modelId: UNVERIFIED_MODEL_ID });

  const tools = (lastStreamTextOptions!.tools ?? {}) as Record<string, unknown>;
  assert.equal(tools.create_text_file, undefined);
  assert.match(promptText(), /choosing a different model/);
  assert.doesNotMatch(promptText(), /Auto routes a file request/);
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

/* GF-13: latest-turn inputs reach the final answer provider whole or are refused. */
const officeRevisionMime = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const addInputFixture = (id: string, extension: string, bytes: Buffer) => {
  const prefix = `attachments/${createHash("sha256").update("artifact-qa@tomverse.app").digest("hex").slice(0, 20)}/`;
  const row = { id, name: `${id}.${extension}`, mediaType: extension === "csv" ? "text/csv"
    : extension === "txt" ? "text/plain" : officeRevisionMime[extension as keyof typeof officeRevisionMime],
    size: bytes.length, kind: extension === "txt" || extension === "csv" ? "text" : "file", objectKey: `${prefix}${id}` };
  world.uploads.push(row);
  world.inputObjects.set(row.objectKey, bytes);
  return { uploadId: id };
};
const clearInputFixtures = () => { world.uploads = []; world.inputObjects.clear(); };
const revisionDocx = (text: string) => Buffer.from(renderDocumentDocx({ filename: "source.docx", format: "docx",
  blocks: [{ type: "paragraph", text }] }));
const revisionPptx = (text: string) => Buffer.from(renderPresentationPptx({ filename: "source.pptx", format: "pptx",
  slides: [{ layout: "titleAndContent", title: "Plan", bullets: [text] }] }));

for (const [extension, render] of [["docx", revisionDocx], ["pptx", revisionPptx]] as const) {
  // Earlier files no longer share one 300,000-character budget with the turn's
  // own file (operator decision 2026-11-16): a large earlier file cannot push
  // the latest file out, and the latest file still arrives whole.
  test(`GF-13 latest ${extension} is sent whole after a large earlier file`, async () => {
    try {
      const historical = addInputFixture("previous-text", "txt", Buffer.from("x".repeat(299_990)));
      const current = addInputFixture("current-office", extension, render("Keep blue. Budget is 200. Tail confirmed."));
      await ask({}, { autoRoutedTo: MODEL_ID, messages: [
        { role: "user", content: "Earlier input", attachments: [historical] },
        { role: "assistant", content: "Understood" },
        { role: "user", content: "Create a revised file from the attachment", attachments: [current] },
      ] });
      assert.ok(lastStreamTextOptions, "final answer provider was not dispatched");
      assert.match(JSON.stringify(lastStreamTextOptions!.messages), /Tail confirmed/);
      assert.equal(world.artifactRows.length, 0);
    } finally { clearInputFixtures(); }
  });

  test(`GF-13 latest ${extension} text fits the remaining budget without losing the tail`, async () => {
    try {
      const historical = addInputFixture("previous-small", "txt", Buffer.from("x".repeat(299_936)));
      const current = addInputFixture("current-fitting", extension, render("Keep blue. Budget is 200. Tail confirmed."));
      await ask({}, { messages: [
        { role: "user", content: "Earlier input", attachments: [historical] },
        { role: "assistant", content: "Understood" },
        { role: "user", content: "Create a revised file from the attachment", attachments: [current] },
      ] });
      assert.ok(lastStreamTextOptions, "final answer provider was not dispatched");
      assert.match(JSON.stringify(lastStreamTextOptions!.messages), /Tail confirmed/);
      assert.equal(world.artifactRows.length, 0, "text-only answer is not a successful file and gets no fake failed card");
    } finally { clearInputFixtures(); }
  });
}

for (const extension of ["txt", "csv"]) {
  // A latest file whose text alone passes the parser ceiling, which no turn
  // could carry, is still refused whole rather than truncated.
  test(`GF-13 latest ${extension} is refused rather than truncated at Send`, async () => {
    try {
      const current = addInputFixture("latest-plain", extension,
        Buffer.from("keep,200\n".repeat(Math.ceil(CHAT_ATTACHMENT_PARSE_CHARACTERS / 9) + 1)));
      const result = await ask({}, { expectedStatus: 413, messages: [
        { role: "user", content: "Create a revised file", attachments: [current] },
      ] });
      assert.equal(JSON.parse(result.body).code, "ATTACHMENT_TEXT_TOO_LARGE");
      assert.equal(lastStreamTextOptions, null);
    } finally { clearInputFixtures(); }
  });
}

test("GF-13 empty latest Office text stops final answer dispatch with a safe error code", async () => {
  try {
    const current = addInputFixture("empty-office", "docx", revisionDocx(""));
    const result = await ask({}, { expectedStatus: 400, messages: [
      { role: "user", content: "Create a revised file", attachments: [current] },
    ] });
    assert.equal(JSON.parse(result.body).code, "ATTACHMENT_NO_TEXT");
    assert.equal(lastStreamTextOptions, null);
    assert.doesNotMatch(result.body, /attachments\//);
  } finally { clearInputFixtures(); }
});

const workbookRevisionFixture = () => {
  const admitted = admitWorkbookSpecSafely({ filename: "source.xlsx", worksheets: [
    { name: "Revenue", title: "Annual revenue", columns: [{ header: "Name", width: 26 },
      { header: "Amount", type: "number", width: 14, format: "currency_usd" }], rows: [["Blue", 200], ["TAIL_MARKER", 300]] },
    { name: "Notes", columns: [{ header: "Active" }], rows: [[false], [null], [""]] },
  ] });
  assert.ok(admitted.ok);
  const canonical = canonicalWorkbookSpecFor(admitted.spec);
  assert.ok(canonical);
  const reference = addInputFixture("private-input-copy", "xlsx", Buffer.from(renderWorkbook(admitted.spec, "xlsx").bytes));
  Object.assign(world.uploads.at(-1)!, { name: "source.xlsx", sourceArtifactId: "private-source-artifact", sourceLineageId: "private-source-lineage",
    sourceConversationId: CONVERSATION_ID, sourceCanonicalSpec: canonical });
  return { reference, canonical };
};

test("XLSX revision Send provides the complete canonical workbook through a request-scoped attachment", async () => {
  const previous = process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  try {
    const { reference, canonical } = workbookRevisionFixture();
    await ask({}, { messages: [{ role: "user", content: "Create a new workbook with the changed amount", attachments: [reference] }] });
    assert.ok(lastStreamTextOptions);
    const prompt = JSON.stringify(lastStreamTextOptions!.messages);
    assert.match(prompt, /TAIL_MARKER/);
    assert.match(prompt, /currency_usd/);
    assert.match(JSON.stringify(lastStreamTextOptions!.instructions), /att_1/);
    assert.doesNotMatch(prompt, /private-source-artifact|private-source-lineage|private-input-copy|attachments\//);
    const expected = JSON.stringify(canonical.spec);
    assert.ok(prompt.includes(JSON.stringify(expected).slice(1, -1)), "the full structured workbook must reach the existing attachment fence");
    assert.equal(world.artifactRows.length, 0, "a text-only answer must not create a fake file card");
  } finally {
    clearInputFixtures();
    if (previous === undefined) delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
    else process.env.GENERATED_ARTIFACT_REVISION_ENABLED = previous;
  }
});

test("XLSX revision Send keeps the whole workbook after a large earlier file", async () => {
  const previous = process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  try {
    const historical = addInputFixture("historical-budget", "txt", Buffer.from("x".repeat(299_990)));
    const { reference } = workbookRevisionFixture();
    await ask({}, { autoRoutedTo: MODEL_ID, messages: [
      { role: "user", content: "Earlier input", attachments: [historical] },
      { role: "assistant", content: "Understood" },
      { role: "user", content: "Create the revised workbook", attachments: [reference] },
    ] });
    assert.ok(lastStreamTextOptions, "final answer provider was not dispatched");
    assert.match(JSON.stringify(lastStreamTextOptions!.messages), /TAIL_MARKER/);
    assert.equal(world.artifactRows.length, 0);
  } finally {
    clearInputFixtures();
    if (previous === undefined) delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
    else process.env.GENERATED_ARTIFACT_REVISION_ENABLED = previous;
  }
});

test("XLSX revision Send refuses missing canonical data and copies from another conversation", async () => {
  const previous = process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  try {
    for (const invalid of ["snapshot", "conversation"]) {
      clearInputFixtures();
      const { reference } = workbookRevisionFixture();
      if (invalid === "snapshot") world.uploads.at(-1)!.sourceCanonicalSpec = null;
      else world.uploads.at(-1)!.sourceConversationId = "another-conversation";
      const result = await ask({}, { expectedStatus: 400, messages: [
        { role: "user", content: "Create the revised workbook", attachments: [reference] },
      ] });
      assert.equal(JSON.parse(result.body).code, invalid === "snapshot" ? "ATTACHMENT_UNREADABLE" : "ATTACHMENT_NOT_FOUND");
      assert.equal(lastStreamTextOptions, null);
      assert.doesNotMatch(result.body, /private-source|attachments\//);
    }
  } finally {
    clearInputFixtures();
    if (previous === undefined) delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
    else process.env.GENERATED_ARTIFACT_REVISION_ENABLED = previous;
  }
});

/* -------------------------------------------------------------------------- */
/* The error report for a turn that failed inside its 200 stream                */
/* -------------------------------------------------------------------------- */

/*
  docs/policy/trace-feedback-automation.md §3.3 (operator decision 2026-11-16).

  An empty answer is settled inside a stream whose headers left long ago, so
  the signed error-report token cannot ride in one. It rides in the trailer.
  Driven through the real route and read back with the real parser and the
  real verifier: this is the token the feedback endpoint will be handed.
*/
const withErrorReportSigning = async <T,>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  process.env.ERROR_REPORT_SIGNING_SECRET = "an-error-report-secret-of-32-chars!!";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
};

type ErrorReportTrailer = { errorReport?: { token: string; code: string } } | null;

test("an empty answer's trailer carries a signed error report for the turn's own trace", async () => {
  const evidence: Array<Record<string, unknown>> = [];
  OVERRIDES.traceErrorEvidence = {
    create: ((args: { data: Record<string, unknown> }) => {
      evidence.push(args.data);
      return args.data;
    }) as (args: never) => unknown,
  };
  try {
    await withErrorReportSigning(async () => {
      const { trailer } = await ask({ text: "" });
      const report = (trailer as ErrorReportTrailer)?.errorReport;
      assert.ok(report, "the empty answer's trailer carried no error report");
      assert.equal(report.code, "AI_EMPTY_RESPONSE.END_TURN");

      const { verifyErrorReportToken } = require(
        resolve(ROOT, "lib/errorReportToken.ts")
      ) as typeof import("../../lib/errorReportToken");
      const outcome = verifyErrorReportToken(report.token);
      assert.equal(outcome.status, "verified");
      assert.equal(outcome.payload?.errorCode, report.code);
      assert.equal(outcome.payload?.routeClass, "chat");
      assert.match(outcome.payload?.traceId ?? "", /^[0-9a-f-]{36}$/);

      // The evidence row the token points at: the server's facts, recorded
      // against the same trace and occurrence, on a response that was a 200.
      await new Promise((settle) => setImmediate(settle));
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].occurrenceId, outcome.payload?.occurrenceId);
      assert.equal(evidence[0].traceId, outcome.payload?.traceId);
      assert.equal(evidence[0].errorCode, report.code);
      assert.equal(evidence[0].httpStatus, 200);
      assert.equal(evidence[0].phase, "stream");
      assert.equal(evidence[0].failureLayer, "provider_stream");
      assert.equal(evidence[0].modelId, MODEL_ID);
    });
  } finally {
    delete OVERRIDES.traceErrorEvidence;
  }
});

test("an answer that completed gets no error report, signing configured or not", async () => {
  await withErrorReportSigning(async () => {
    const { trailer } = await ask({});
    assert.equal((trailer as ErrorReportTrailer)?.errorReport, undefined);
  });
});

test("without a signing secret an empty answer still closes normally, with no report", async () => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  delete process.env.ERROR_REPORT_SIGNING_SECRET;
  try {
    const { trailer } = await ask({ text: "" });
    assert.ok(trailer, "the trailer itself still arrives");
    assert.equal((trailer as ErrorReportTrailer)?.errorReport, undefined);
  } finally {
    if (previous !== undefined) process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
});

test("a stream that breaks mid-answer delivers its error report, then the error it always raised", async () => {
  const providerFailure = Object.assign(new Error("upstream overloaded"), {
    name: "AI_APICallError",
    statusCode: 503,
    isRetryable: true,
  });
  await withErrorReportSigning(async () => {
    const { body, trailer, streamError } = await ask({
      text: "Half an answer",
      failAfterText: providerFailure,
    });
    // The client still sees a broken stream -- an older one behaves exactly
    // as before -- but the trailer was read first.
    assert.equal(streamError, providerFailure);
    assert.ok(body.startsWith("Half an answer"));
    const report = (trailer as ErrorReportTrailer)?.errorReport;
    assert.ok(report, "the failed stream delivered no error report before breaking");
    assert.equal(report.code, "AI_STREAM_FAILED.AI_APICallError.HTTP_503.RETRYABLE");

    const { verifyErrorReportToken } = require(
      resolve(ROOT, "lib/errorReportToken.ts")
    ) as typeof import("../../lib/errorReportToken");
    const outcome = verifyErrorReportToken(report.token);
    assert.equal(outcome.status, "verified");
    assert.equal(outcome.payload?.errorCode, report.code);
  });
});

test("a broken stream with signing off raises the same error and sends no trailer", async () => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  delete process.env.ERROR_REPORT_SIGNING_SECRET;
  try {
    const failure = new Error("upstream closed");
    const { body, trailer, streamError } = await ask({ text: "Half", failAfterText: failure });
    assert.equal(streamError, failure);
    assert.equal(trailer, null);
    assert.equal(body, "Half");
  } finally {
    if (previous !== undefined) process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
});

/* -------------------------------------------------------------------------- */
/* A file with no prose above it                                                */
/* -------------------------------------------------------------------------- */

/*
  docs/policy/generated-artifacts.md section 8 (2026-11-27). A tool that stored
  a file and a model that then wrote nothing -- or ran out of steps -- used to
  end as "empty response": the stored file was deleted and the turn settled as
  empty. The file is the answer, so it is kept with its message and charged as
  one.
*/
test("a file stored with no prose keeps its message and its row, and settles completed", async () => {
  await withErrorReportSigning(async () => {
    const { trailer } = await ask({
      begins: [beganTextFile],
      executes: [beganTextFile.toolCallId],
      text: "",
    });
    assert.equal(trailer?.completion?.status, "normal");
    assert.equal(trailer?.artifacts?.length, 1);
    assert.equal(trailer?.artifacts?.[0]!.status, "ready");
    // The persisted row's id, so the card survives a reload.
    assert.equal(trailer?.artifacts?.[0]!.id, "row_1");
    // A delivered file is not a failed turn.
    assert.equal((trailer as ErrorReportTrailer)?.errorReport, undefined);
  });
  // An empty body: the sentence above the card is the screen's own.
  assert.deepEqual(
    world.messages.map((message) => [message.id, message.status, message.content]),
    [[ASSISTANT_MESSAGE_ID, "normal", ""]]
  );
  assert.equal(world.artifactRows.length, 1);
  assert.equal(world.artifactRows[0]!.status, "ready");
  assert.equal(world.artifactRows[0]!.messageId, ASSISTANT_MESSAGE_ID);
  assert.deepEqual(world.settlements, ["completed"]);
  assert.equal(world.discarded, 0, "the delivered file was reclaimed");
});

test("whitespace a model emitted around a file is not stored as its body", async () => {
  await ask({
    begins: [beganTextFile],
    executes: [beganTextFile.toolCallId],
    text: "\n  \n",
  });
  assert.deepEqual(world.messages.map((message) => message.content), [""]);
  assert.deepEqual(world.settlements, ["completed"]);
});

test("an answer with neither text nor a file is still empty: no message, no charge", async () => {
  await ask({ text: "" });
  assert.deepEqual(world.messages, []);
  assert.deepEqual(world.artifactRows, []);
  assert.deepEqual(world.settlements, ["empty"]);
});

/*
  The other half of the same decision (G4). A call the output ceiling cut off
  is a `turn_incomplete` card the server records -- and with no text the
  message used to be skipped, so the card the user saw while it streamed was
  gone on reload, against section 9. The card is kept with its message; the
  turn delivered no file, so it still settles as the empty answer it is.
*/
test("a turn_incomplete card with no text is stored with its message and settles empty", async () => {
  const { trailer } = await ask({
    begins: [beganTextFile],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
    text: "",
  });
  assert.equal(trailer?.completion?.status, "incomplete");
  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]!.failureCode, "turn_incomplete");
  // The row's own id: the card is what a reload will find.
  assert.equal(trailer?.artifacts?.[0]!.id, "row_1");
  assert.deepEqual(
    world.messages.map((message) => [message.id, message.status, message.content]),
    [[ASSISTANT_MESSAGE_ID, "incomplete", ""]]
  );
  assert.equal(world.artifactRows.length, 1);
  assert.equal(world.artifactRows[0]!.status, "failed");
  assert.equal(world.artifactRows[0]!.failureCode, "turn_incomplete");
  assert.deepEqual(world.settlements, ["empty"]);
});

test("a generation that failed with no text keeps its failure card and settles empty", async () => {
  const { trailer } = await ask({
    begins: [{ toolCallId: "collector_1", toolName: "create_text_file" }],
    executes: ["collector_1"],
    executeInput: { format: "txt", filename: "notes.txt", content: "x" },
    text: "",
  });
  assert.equal(trailer?.artifacts?.length, 1);
  assert.equal(trailer?.artifacts?.[0]!.status, "failed");
  assert.equal(trailer?.artifacts?.[0]!.id, "row_1");
  assert.deepEqual(world.messages.map((message) => message.content), [""]);
  assert.deepEqual(world.settlements, ["empty"]);
});

test("a delivered file and a failure card alone are settled differently", async () => {
  await ask({ begins: [beganTextFile], executes: [beganTextFile.toolCallId], text: "" });
  const delivered = [...world.settlements];
  await ask({
    begins: [beganTextFile],
    executes: [],
    finishReason: "length",
    rawFinishReason: "max_tokens",
    text: "",
  });
  const cardOnly = [...world.settlements];
  assert.deepEqual([delivered, cardOnly], [["completed"], ["empty"]]);
});

/* -------------------------------------------------------------------------- */
/* The Message write that fails                                                 */
/* -------------------------------------------------------------------------- */

/*
  S3. Settlement runs before the Message transaction and is not rolled back
  with it -- the user read the answer and the provider ran. What changed is how
  often the write is lost: a retryable database error is run again, up to
  twice, once a read shows the failed try did not land; and a turn with no
  attempt row that still cannot be saved says so in the trailer.
*/
const retryableWriteError = () =>
  Object.assign(new Error("write conflict"), {
    name: "PrismaClientKnownRequestError",
    code: "P2034",
  });
type NotSavedTrailer = { notSaved?: true } | null;
const withMessageCreateFailures = async <T,>(
  failures: unknown[],
  landsBeforeThrow: boolean,
  run: () => Promise<T>
): Promise<T> => {
  world.messageCreateFailures = failures;
  world.landsBeforeThrow = landsBeforeThrow;
  try {
    return await run();
  } finally {
    world.messageCreateFailures = [];
    world.landsBeforeThrow = false;
  }
};

test("a retryable failure of the Message write is run again and the answer is saved once", async () => {
  const { trailer } = await withMessageCreateFailures([retryableWriteError()], false, () =>
    ask({ begins: [beganTextFile], executes: [beganTextFile.toolCallId] })
  );
  assert.equal(world.messageCreateCalls, 2);
  assert.deepEqual(world.messages.map((message) => message.content), [ANSWER]);
  assert.equal(world.artifactRows.length, 1);
  assert.equal(world.discarded, 0);
  assert.equal(trailer?.artifacts?.[0]!.status, "ready");
  assert.equal((trailer as NotSavedTrailer)?.notSaved, undefined);
  assert.deepEqual(world.settlements, ["completed"]);
});

test("a write that landed before its error is found, not written a second time", async () => {
  const { trailer } = await withMessageCreateFailures([retryableWriteError()], true, () =>
    ask({})
  );
  assert.equal(world.messageCreateCalls, 1, "the landed write was run again");
  assert.equal(world.messages.length, 1);
  assert.equal((trailer as NotSavedTrailer)?.notSaved, undefined);
});

test("a write that keeps failing tells the browser the answer was not saved; billing is unchanged", async () => {
  const failures = [retryableWriteError(), retryableWriteError(), retryableWriteError()];
  const { body, trailer } = await withMessageCreateFailures(failures, false, () =>
    ask({ begins: [beganTextFile], executes: [beganTextFile.toolCallId] })
  );
  assert.equal(world.messageCreateCalls, 3, "two more tries, no more");
  assert.deepEqual(world.messages, []);
  assert.ok(body.startsWith(ANSWER), "the answer still streamed");
  assert.equal((trailer as NotSavedTrailer)?.notSaved, true);
  // The file's row was never written, so neither is its card.
  assert.equal(trailer?.artifacts, undefined);
  assert.equal(world.discarded, 1);
  // Settled before the write, and not rolled back with it.
  assert.deepEqual(world.settlements, ["completed"]);
});

test("a non-retryable Message write failure is not retried", async () => {
  const refusal = Object.assign(new Error("duplicate"), {
    name: "PrismaClientKnownRequestError",
    code: "P2002",
  });
  const { trailer } = await withMessageCreateFailures([refusal], false, () => ask({}));
  assert.equal(world.messageCreateCalls, 1);
  assert.equal((trailer as NotSavedTrailer)?.notSaved, true);
});
