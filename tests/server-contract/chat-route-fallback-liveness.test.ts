import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import * as aiModule from "ai";
import { validatePromptRefinerChatExecution } from "@/lib/promptRefinerChatExecutionCore";
import { preflightInputEstimate } from "@/lib/autoDispatchPreflight";
import { buildTaskProfile } from "@/lib/taskProfileCore";

/**
 * §7's automatic fallback, executed through the route that performs it.
 *
 * ## The gap this closes
 *
 * The fallback's *policy* is covered (`tests/automaticFallbackBoundary.test.mjs`),
 * its *attempt sequence* is covered (`tests/routingAttemptSequence.test.mjs`),
 * and its *provider hold and settlement* are covered
 * (`tests/integration/chat-attempt-usage.db.test.ts`). What nothing executed
 * was `attemptFallback()` inside `app/api/chat/route.ts` -- the orchestration
 * that joins them: a routed turn whose primary dies before a visible token,
 * the swap announced in the stream, and a second model finishing the answer.
 *
 * That matters now because the first-token watch added for the stream liveness
 * fix spans both attempts. It is tied to "no visible token yet", which is
 * exactly the window §7 allows a fallback in, and its deadline is deliberately
 * *absolute* rather than restarted by the swap. Both of those were claims made
 * by construction and by comment; this is what executes them.
 *
 * ## How the turn is driven
 *
 * Entirely through environment variables and one request header -- no module
 * mock stands between the test and the routing decision. That is deliberate:
 * the keepalive contract file next door originally shrank its budgets with
 * `mock.module`, which applied locally and silently did not on CI, and every
 * case in it failed on the guard that noticed. Anything this file can drive
 * the way an operator would, it drives that way.
 *
 * The four locks on `lib/autoDrillOverride.ts` are all environment-shaped, and
 * `lib/routingFaultInjection.ts` already exists to make a primary fail before
 * its first chunk -- it is step 4 of the staging fallback drill
 * (`docs/ops/tomverse-chat-fallback-drill.md`). This uses the same two, which
 * is why the turn can be routed at all while the readiness register is
 * outstanding.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* The deployment this turn thinks it is running in                            */
/* -------------------------------------------------------------------------- */

const FAULT_SECRET = "fallback-drill-secret-0123456789";
const USER_ID = "fallback-user-1";
const CONVERSATION_ID = "fallback-conversation-1";
const ASSISTANT_MESSAGE_ID = "33333333-4444-4555-8666-777777777777";
const SOURCE_USER_MESSAGE_ID = "11111111-2222-4333-8444-555555555555";
const REQUESTED_MODEL_ID = "claude-haiku-4-5";
const ANSWER = "The second model finished the answer.";
const REFINER_PROMPT = "이 질문에 답해 줘. 사용자가 작성한 질문을 그대로 이해하고, 필요한 설명을 충분히 제공해 줘.";
const REFINER_SCOPE_ID = "44444444-4444-4444-8444-444444444444";
const REFINER_SUGGESTION_ID = "55555555-5555-4555-8555-555555555555";
let refinerMode: "explicit" | "auto" | null = null;
let refinerConsumes = 0;
let pinnedResponse: Response | null = null;
let pinnedInputs: readonly object[] | null = null;
const routerInputs: Array<Parameters<typeof import("../../lib/autoModelSelection").selectAutoModel>[0]> = [];
const shadowInputs: Array<import("../../lib/routingShadow").RoutingShadowInput> = [];

const realPinnedRoute = require(resolve(ROOT, "lib/pinnedDeploymentRoute.ts")) as typeof import("../../lib/pinnedDeploymentRoute");
mock.module(mod("lib/pinnedDeploymentRoute.ts"), { namedExports: {
  enterPinnedDeploymentChat: (input: Parameters<typeof realPinnedRoute.enterPinnedDeploymentChat>[0]) => {
    if (!pinnedResponse) return realPinnedRoute.enterPinnedDeploymentChat(input);
    pinnedInputs = input.messages;
    return Promise.resolve({ route: "dispatched" as const, providerCalls: 1 as const,
      hold: "settled" as const, response: pinnedResponse });
  },
} });

// The real store's lock/CAS/audit boundary has separate PostgreSQL tests.
// This fixture supplies its validated result to the real Chat orchestration;
// no checked-in release authority, AppSetting or provider key is enabled.
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: () => ({
    explicitEnabled: refinerMode === "explicit", autoEnabled: refinerMode === "auto",
  }),
} });
mock.module(mod("lib/promptRefinerChatExecutionStore.ts"), { namedExports: {
  consumePromptRefinerChatExecution: async (
    input: Parameters<typeof import("../../lib/promptRefinerChatExecutionStore").consumePromptRefinerChatExecution>[0]
  ) => {
    assert.equal(refinerConsumes, 0);
    assert.ok(refinerMode);
    const view = validatePromptRefinerChatExecution({ ...input,
      held: { id: REFINER_SUGGESTION_ID, userId: USER_ID, conversationId: CONVERSATION_ID,
        surface: "chat", scopeId: REFINER_SCOPE_ID, scopeEpoch: 1, recoveryEpoch: 0,
        sourceMessageId: SOURCE_USER_MESSAGE_ID, sourcePrompt: "이 질문에 답해 줘",
        refinedPrompt: REFINER_PROMPT, requestId: "66666666-6666-4666-8666-666666666666",
        refinerVersion: "suggest-v2", mode: refinerMode, state: "ready",
        expiresAt: new Date("2026-10-10T00:05:00Z") },
      facts: { userId: USER_ID, conversationId: CONVERSATION_ID,
        sourceMessageId: SOURCE_USER_MESSAGE_ID, persistedSourcePrompt: "이 질문에 답해 줘",
        recoveryEpoch: 0, scope: { id: REFINER_SCOPE_ID, epoch: 1, surface: "chat", conversationId: CONVERSATION_ID },
        dbNow: new Date("2026-10-10T00:00:00Z"), explicitEnabled: refinerMode === "explicit",
        autoEnabled: refinerMode === "auto", autoConversation: conversationSelectionMode === "auto", killSwitch: false },
    });
    refinerConsumes += 1;
    return view;
  },
} });
const realAutoSelection = require(resolve(ROOT, "lib/autoModelSelection.ts")) as typeof import("../../lib/autoModelSelection");
mock.module(mod("lib/autoModelSelection.ts"), { namedExports: {
  ...realAutoSelection,
  selectAutoModel: (input: Parameters<typeof realAutoSelection.selectAutoModel>[0]) => {
    routerInputs.push(input);
    return realAutoSelection.selectAutoModel(input);
  },
} });
const realRoutingShadow = require(resolve(ROOT, "lib/routingShadow.ts")) as typeof import("../../lib/routingShadow");
mock.module(mod("lib/routingShadow.ts"), { namedExports: {
  ...realRoutingShadow,
  isRouterShadowEnabled: () => refinerMode !== null || realRoutingShadow.isRouterShadowEnabled(),
  scheduleRoutingShadowRun: (buildInput: () => import("../../lib/routingShadow").RoutingShadowInput) => {
    if (refinerMode !== null) shadowInputs.push(buildInput());
    else realRoutingShadow.scheduleRoutingShadowRun(buildInput);
  },
} });

/** Milliseconds. Chosen the same way the keepalive file's are -- see there. */
const KEEPALIVE_INTERVAL_MS = 25;
const FIRST_TOKEN_DEADLINE_MS = 1_500;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
// Always replace an inherited key so this no-provider fixture cannot make a paid call.
process.env.OPENAI_API_KEY = "server-contract-test-key";
process.env.ANTHROPIC_API_KEY ||= "server-contract-test-key";

// Lock 1 of the drill override: not production. `resolveDeploymentEnvironment`
// fails closed, so this has to be said out loud.
process.env.APP_ENV = "staging";
// Lock 2: the fault-injection credential, which is also what makes the primary
// fail below. One secret, not two.
process.env.ROUTING_FAULT_INJECTION_SECRET = FAULT_SECRET;
// Lock 3: an explicit subject allowlist. Empty would route nobody.
process.env.AUTO_ROUTER_DRILL_SUBJECTS = USER_ID;

// The cohort itself is not bypassed by the drill override -- only readiness is
// -- so the rollout still has to admit this account.
process.env.AUTO_ROUTER_KILL_SWITCH = "off";
process.env.AUTO_ROUTER_ROLLOUT_PERCENT = "100";
process.env.AUTO_ROUTER_ELIGIBLE_PLANS = "Pro";
process.env.AUTO_ROUTER_COHORT_SALT = "fallback-contract-salt";

// The feature under test, off by default in every deployment.
process.env.AUTO_ROUTER_FALLBACK_ENABLED = "on";

// The liveness budgets, through the same operator seam the keepalive file uses.
process.env.CHAT_STREAM_KEEPALIVE_INTERVAL_MS = String(KEEPALIVE_INTERVAL_MS);
process.env.CHAT_FIRST_TOKEN_DEADLINE_MS = String(FIRST_TOKEN_DEADLINE_MS);

mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => ({
      user: { id: USER_ID, email: "fallback-qa@tomverse.app" },
    }),
  },
});

let durableAttemptAdmissionRefused = false;
let durableAttemptAdmissionCalls = 0;
class TestApiSecurityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number
  ) {
    super(message);
  }
}
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    apiSecurityResponse: (error: unknown) =>
      error instanceof TestApiSecurityError
        ? Response.json(
            { error: error.message, code: error.code },
            {
              status: error.status,
              headers: error.retryAfter
                ? { "Retry-After": String(error.retryAfter) }
                : undefined,
            }
          )
        : null,
    assertMessageCapacity: async () => undefined,
    consumeApiRateLimit: async (
      _request: Request,
      _userId: string,
      scope: string
    ) => {
      if (scope !== "chat-durable-attempt") return;
      durableAttemptAdmissionCalls += 1;
      if (durableAttemptAdmissionRefused) {
        throw new TestApiSecurityError(
          429,
          "API_RATE_LIMITED",
          "Too many requests.",
          30
        );
      }
    },
    readLimitedJson: async () => ({}),
    reserveDailyUploadBytes: async () => undefined,
  },
});

let contextConsumeSucceeds = true;
mock.module(mod("lib/chatTurnContext.ts"), {
  namedExports: {
    buildChatTurnContext: async () => ({
      fingerprint: "verified-context-fingerprint",
      fingerprintInput: {},
      systemPrompt: null,
      memoryTokens: 0,
      profileTokens: 0,
      memory: {
        prompt: { text: null, usedCount: 0 },
        truncatedByBudget: false,
      },
      profile: { knowledgeChunkCount: 0 },
    }),
  },
});
mock.module(mod("lib/chatContextBundleService.ts"), {
  namedExports: {
    verifyChatContextBundle: () => ({
      ok: true,
      payload: {
        bundleId: "context-bundle-one",
        expiresAtMs: Date.now() + 60_000,
        memoryTokens: 0,
        profileTokens: 0,
      },
    }),
    consumeContextBundle: async () =>
      contextConsumeSucceeds
        ? { consumed: true }
        : { consumed: false, reason: "already_consumed" },
  },
});

/* -------------------------------------------------------------------------- */
/* The provider streams these two attempts get                                 */
/* -------------------------------------------------------------------------- */

type Attempt = {
  /** The model id `streamText` was asked for. */
  modelId: string | null;
  /** Whether its stream was cancelled, and with what. */
  cancelledWith: unknown;
  /** What reached the provider-facing abort signal. */
  providerAbortedWith: unknown;
  /** The provider signal state at the exact reader-cancel boundary. */
  providerAbortedBeforeReaderCancel: boolean;
  messages: Array<{ role: string; content: unknown }>;
};

const attempts: Attempt[] = [];
const attemptLifecycle: string[] = [];

/**
 * What the second attempt does.
 *
 * `"answers"` is the ordinary §7 recovery. `"silent"` opens its stream and
 * never writes, which is how the absolute first-token deadline is observed
 * spanning the swap.
 */
let fallbackBehaviour:
  | "answers"
  | "silent"
  | "partial"
  | "completion_wait" = "answers";
let injectPrimaryFault = true;
let completionUsageRead = false;
let releasePendingCompletionUsage: () => void = () => {};
let fallbackTransitionAbortAt:
  | "none"
  | "after_stream_created"
  | "during_record_dispatched"
  | "during_primary_reader_cancel" = "none";
let abortActiveRequest: () => void = () => {};
let recordDispatchedCalls = 0;
let throwAfterFallbackDispatchRecord = false;
let throwBeforeFallbackStreamReturn = false;

mock.module("ai", {
  namedExports: {
    ...aiModule,
    streamText: (options: Record<string, unknown>) => {
      const index = attempts.length;
      if (index > 0 && throwBeforeFallbackStreamReturn) {
        throw new Error("FALLBACK_STREAM_CONSTRUCTOR_TEST_FAILURE");
      }
      const attempt: Attempt = {
        modelId:
          (options.model as { modelId?: string } | undefined)?.modelId ?? null,
        cancelledWith: null,
        providerAbortedWith: null,
        providerAbortedBeforeReaderCancel: false,
        messages: options.messages as Attempt["messages"],
      };
      attempts.push(attempt);
      attemptLifecycle.push(`${index}:provider_start`);
      // Attempt 0 is failed by the injected fault, not by this stream: the
      // route wraps the reader in `faultedReader`, which is the drill's own
      // mechanism rather than a shape invented here.
      const silent = index > 0 && fallbackBehaviour === "silent";
      const partial = index > 0 && fallbackBehaviour === "partial";
      const completionWait =
        index > 0 && fallbackBehaviour === "completion_wait";
      const abortSignal = options.abortSignal as AbortSignal | undefined;
      const observeProviderAbort = () => {
        attempt.providerAbortedWith = abortSignal?.reason ?? "aborted";
        attemptLifecycle.push(`${index}:provider_abort`);
      };
      if (abortSignal?.aborted) observeProviderAbort();
      else abortSignal?.addEventListener("abort", observeProviderAbort, { once: true });

      const usage = {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 0 },
        outputTokenDetails: { reasoningTokens: 0 },
      };
      const usagePromise = completionWait
        ? new Promise<typeof usage>((resolve) => {
            releasePendingCompletionUsage = () => resolve(usage);
          })
        : Promise.resolve(usage);

      if (index > 0 && fallbackTransitionAbortAt === "after_stream_created") {
        queueMicrotask(abortActiveRequest);
      }

      return {
        textStream: new ReadableStream<string>({
          start(controller) {
            if ((index === 0 && injectPrimaryFault) || silent) return;
            controller.enqueue(ANSWER);
            if (!partial) controller.close();
          },
          cancel(reason) {
            if (
              index === 0 &&
              fallbackTransitionAbortAt === "during_primary_reader_cancel"
            ) {
              abortActiveRequest();
            }
            attempt.providerAbortedBeforeReaderCancel = abortSignal?.aborted === true;
            attempt.cancelledWith = reason ?? "cancelled";
            attemptLifecycle.push(`${index}:reader_cancel`);
          },
        }),
        response: Promise.resolve({
          id: `resp-fallback-${index}`,
          modelId: attempt.modelId,
          headers: {},
          messages: [],
        }),
        get usage() {
          if (completionWait) completionUsageRead = true;
          return usagePromise;
        },
        finishReason: Promise.resolve("stop"),
        rawFinishReason: Promise.resolve("end_turn"),
        content: Promise.resolve([]),
        providerMetadata: Promise.resolve({}),
      };
    },
  },
});

/* -------------------------------------------------------------------------- */
/* The database                                                                */
/* -------------------------------------------------------------------------- */

const world = {
  messages: [] as Array<{ id: string; status: string; modelId: string }>,
  terminals: [] as Array<Record<string, unknown>>,
};
let failAssistantPersistence = false;

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

/*
  `selectionMode: "auto"` is what makes this a routed turn rather than a manual
  one, and `productKey: "chat"` is what lets it be routed at all --
  `lib/autoProductBoundary.ts` refuses Review and Studio before the cohort is
  ever consulted.
*/
let conversationSelectionMode: "auto" | "manual" = "auto";
const attachmentObjectPrefix = `attachments/${createHash("sha256")
  .update("fallback-qa@tomverse.app")
  .digest("hex")
  .slice(0, 20)}/`;
type MockStoredAttachment = {
  id: string;
  uploadId: string | null;
  userId: string;
  conversationId: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "text" | "file";
  objectKey: string;
  unavailableAt: null;
  unavailableReason: null;
};
let persistedSourceAttachments: MockStoredAttachment[] = [];
let resolvedAttachmentRows: MockStoredAttachment[] = [];
const syntheticR2Objects = new Map<string, Buffer>();
const realR2 = require(resolve(ROOT, "lib/r2.ts")) as typeof import("../../lib/r2");
mock.module(mod("lib/r2.ts"), { namedExports: {
  ...realR2,
  readR2Object: async (key: string) => {
    const body = syntheticR2Objects.get(key);
    assert.ok(body, "this contract suite must never read live storage");
    return Buffer.from(body);
  },
} });
let conversationProductKey: "chat" | "review" = "chat";
let messageFindFirstArgs: Array<Record<string, unknown>> = [];
let lastDurableClaimInput: Record<string, unknown> | null = null;
type InstrumentationAttemptRow = {
  id: string;
  attemptIndex: number;
  modelId: string;
  state: "draft" | "finalized" | "dispatch_started" | "dispatched" | "terminal";
};
const instrumentationAttemptRows = new Map<string, InstrumentationAttemptRow>();
const closedInstrumentationAttempts: Array<
  Omit<InstrumentationAttemptRow, "state"> & { outcome: string }
> = [];

const conversationRow = () => ({
  id: CONVERSATION_ID,
  userId: USER_ID,
  password: null,
  selectedModels: JSON.stringify([REQUESTED_MODEL_ID]),
  kind: "chat",
  productKey: conversationProductKey,
  selectionMode: conversationSelectionMode,
  chatRecoveryEpoch: 0,
});

const OVERRIDES: Record<string, Record<string, (args: never) => unknown>> = {
  conversation: {
    findUnique: () => conversationRow(),
    findFirst: () => conversationRow(),
  },
  message: {
    findFirst: (args: Record<string, unknown>) => {
      messageFindFirstArgs.push(args);
      const where = args.where as { id?: string; role?: string } | undefined;
      if (where?.role === "assistant") {
        return {
          id: ASSISTANT_MESSAGE_ID,
          role: "assistant",
          content: "Recovered canonical answer.",
          status: "normal",
          modelId: REQUESTED_MODEL_ID,
          pendingJobId: null,
          searchMetadata: null,
          createdAt: new Date("2026-09-13T00:00:00.000Z"),
          memoryUsedCount: 2,
          knowledgeChunkCount: 1,
          artifacts: [],
          attachments: [],
          providerContext: { private: true },
        };
      }
      return {
        id: where?.id ?? SOURCE_USER_MESSAGE_ID,
        content: "이 질문에 답해 줘",
        attachments: persistedSourceAttachments,
      };
    },
    create: (args: {
      data: { id: string; status: string; modelId: string };
    }) => {
      if (failAssistantPersistence && args.data.id === ASSISTANT_MESSAGE_ID) {
        throw new Error("FORCED_ASSISTANT_MESSAGE_TX_FAILURE");
      }
      world.messages.push({
        id: args.data.id,
        status: args.data.status,
        modelId: args.data.modelId,
      });
      return args.data;
    },
  },
  messageAttachment: {
    findMany: () => resolvedAttachmentRows,
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

let durableRevision = 0;
let durableClaimMode:
  | "claimed"
  | "reattach"
  | "reattach-completed"
  | "conflict" = "claimed";
let durableClaimCalls = 0;
let durableTerminalFails = false;
class DurableConflict extends Error {
  readonly code = "CHAT_ATTEMPT_ID_REUSED";
}
mock.module(mod("lib/chatResponseAttemptPersistence.ts"), {
  namedExports: {
    ChatAttemptCapacityError: class extends Error {
      readonly code = "CHAT_ATTEMPT_STORAGE_QUOTA_EXCEEDED";
      readonly status = 409;
    },
    ChatAttemptCasError: class extends Error { readonly code = "CHAT_ATTEMPT_REVISION_CONFLICT"; },
    ChatAttemptIdentityConflictError: DurableConflict,
    ChatAttemptScopeError: class extends Error { readonly code = "CHAT_ATTEMPT_SCOPE_NOT_FOUND"; },
    claimChatResponseAttempt: async (input: Record<string, unknown>) => {
      durableClaimCalls += 1;
      lastDurableClaimInput = input;
      if (durableClaimMode === "conflict") throw new DurableConflict();
      return {
      disposition: durableClaimMode === "reattach-completed"
        ? "reattach"
        : durableClaimMode,
      attempt: {
        ...input,
        fingerprint: "a".repeat(64),
        actualModelId: durableClaimMode === "reattach-completed"
          ? REQUESTED_MODEL_ID
          : null,
        provider: durableClaimMode === "reattach-completed" ? "anthropic" : null,
        status: durableClaimMode === "reattach-completed" ? "completed" : "claimed",
        partialContent: durableClaimMode === "reattach-completed"
          ? "Recovered canonical answer."
          : "",
        checkpointRevision: durableClaimMode === "reattach-completed" ? 3 : 0,
        finishReason: durableClaimMode === "reattach-completed" ? "stop" : null,
        failureCode: null,
        terminalAt: durableClaimMode === "reattach-completed"
          ? new Date("2026-09-13T00:00:03.000Z")
          : null,
        createdAt: new Date("2026-09-13T00:00:00.000Z"),
        updatedAt: new Date("2026-09-13T00:00:00.000Z"),
      },
    };
    },
    checkpointChatResponseAttempt: async (input: Record<string, unknown>) => ({
      ...input,
      fingerprint: "a".repeat(64),
      requestedModelId: REQUESTED_MODEL_ID,
      status: "streaming",
      checkpointRevision: ++durableRevision,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      finishReason: null,
      failureCode: null,
      terminalAt: null,
      createdAt: new Date("2026-09-13T00:00:00.000Z"),
      updatedAt: new Date("2026-09-13T00:00:00.000Z"),
    }),
    terminalChatResponseAttempt: async (input: Record<string, unknown>) => {
      world.terminals.push(input);
      if (durableTerminalFails) throw new Error("DURABLE_TERMINAL_TEST_FAILURE");
      return undefined;
    },
  },
});

/* -------------------------------------------------------------------------- */
/* The seams that cost money and hold slots                                    */
/* -------------------------------------------------------------------------- */

const realChatSecurity = require(resolve(ROOT, "lib/chatSecurity.ts")) as Record<
  string,
  unknown
>;

/*
  The provider hold the primary took, and the periods it was taken in.

  `attemptFallback` refuses outright without both -- a second hold has to go
  into the same day and month the first one did, and a turn that reserved
  nothing has no evidence of which those were.

  Held for every provider in the catalogue rather than for one. The Router
  picks the primary, and which model that is depends on the catalogue, on
  health signals and on the profile of the prompt -- none of which this file
  is asserting about. Naming a single provider here would make the test fail
  with `no_provider_hold` the day the Router's answer changed, which is a
  fact about the catalogue rather than about the fallback.
*/
const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts")) as {
  AVAILABLE_MODELS: ReadonlyArray<{ provider: string; enabled?: boolean }>;
};

const HELD_PROVIDERS = [
  ...new Set(
    AVAILABLE_MODELS.filter((model) => model.enabled !== false).map(
      (model) => model.provider
    )
  ),
];

const providerHoldEntries = HELD_PROVIDERS.flatMap((provider) => [
  {
    key: `provider:${provider}`,
    period: "provider-cost-day",
    amountMicroUsd: 1_000,
  },
  {
    key: `provider:${provider}`,
    period: "provider-cost-month",
    amountMicroUsd: 1_000,
  },
]);

const reservation = {
  reservationId: "reservation-fallback-1",
  userId: USER_ID,
  traceId: "trace-fallback-1",
  source: "chat" as const,
  modelId: REQUESTED_MODEL_ID,
  provider: "anthropic" as const,
  entries: providerHoldEntries,
};

const ledger = {
  accessAcquisitions: 0,
  settlements: [] as Array<{ outcome: string; attempts: number | null }>,
  settledAttempts: [] as Array<{ attemptIndex: number; modelId: string }>,
  attemptBudgetReleasesAtSettlement: [] as number[],
  releases: [] as Array<{ leaseId: string }>,
  attemptBudgetReservations: 0,
  attemptBudgetReleases: 0,
};

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => {
      ledger.accessAcquisitions += 1;
      return {
        leaseId: "lease-fallback-1",
        setCookie: undefined,
        usageReservation: reservation,
      };
    },
    releaseChatAccess: async (leaseId: string) => {
      ledger.releases.push({ leaseId });
    },
    heartbeatChatAccess: async () => true,
    settleChatUsage: async (
      _reservation: unknown,
      usage: { outcome?: string },
      extra?: {
        attempts?: Array<{
          attemptIndex: number;
          price: { modelId: string };
        }>;
      }
    ) => {
      ledger.settlements.push({
        outcome: usage?.outcome ?? "unknown",
        attempts: extra?.attempts ? extra.attempts.length : null,
      });
      ledger.settledAttempts = (extra?.attempts ?? []).map((attempt) => ({
        attemptIndex: attempt.attemptIndex,
        modelId: attempt.price.modelId,
      }));
      ledger.attemptBudgetReleasesAtSettlement.push(
        ledger.attemptBudgetReleases
      );
    },
    linkChatReservationProviderRequest: async () => undefined,
    reserveAttemptProviderBudget: async (input: { provider?: string }) => {
      ledger.attemptBudgetReservations += 1;
      return {
        reserved: true as const,
        entries: [
          {
            key: `provider:${input?.provider ?? "anthropic"}`,
            period: "provider-cost-day",
            amountMicroUsd: 1_000,
          },
        ],
      };
    },
    releaseAttemptProviderBudget: async () => {
      ledger.attemptBudgetReleases += 1;
    },
  },
});

/*
  The plan the cohort admits. Read before the Router runs, so a null here is
  `plan_not_eligible` and the turn is never routed -- which would make every
  assertion below fail for a reason that is not this contract.
*/
const realBillingEntitlements = require(
  resolve(ROOT, "lib/billingEntitlements.ts")
) as Record<string, unknown>;

mock.module(mod("lib/billingEntitlements.ts"), {
  namedExports: {
    ...realBillingEntitlements,
    getUserBillingPlan: async () => ({
      tier: "Pro",
      status: "active",
      allowAttachments: true,
    }),
  },
});

// Constructing a provider client reads API keys and is not what is under test.
// Both attempts go through it, which is also how each one's model id is seen.
mock.module(mod("lib/activeAiModel.ts"), {
  namedExports: {
    getActiveAiModel: (model: { id?: string }) => ({
      modelId: model?.id ?? REQUESTED_MODEL_ID,
    }),
  },
});

/*
  The PostgreSQL suite owns the instrumentation schema and atomic-write
  contract. This route fixture supplies two bounded synthetic attempt records
  with distinct ids and models, then enforces their real lifecycle at the
  orchestration boundary: draft -> finalized -> dispatched -> terminal. That
  makes a duplicate primary close or a cancellation attached to the wrong
  attempt fail here without turning this no-provider contract test into a
  second database test.
*/
const dispatchCloses: Array<{
  attemptId: string | null;
  modelId: string | null;
  outcome: string;
  firstVisibleTokenAt: unknown;
}> = [];
const realDispatchInstrumentation = require(
  resolve(ROOT, "lib/routingDispatchInstrumentation.ts")
) as Record<string, unknown>;
mock.module(mod("lib/routingDispatchInstrumentation.ts"), {
  namedExports: {
    ...realDispatchInstrumentation,
    beginInstrumentedDispatch: async (input: { modelId: string }) => {
      const row: InstrumentationAttemptRow = {
        id: `routing-attempt-0-${input.modelId}`,
        attemptIndex: 0,
        modelId: input.modelId,
        state: "draft",
      };
      instrumentationAttemptRows.set(row.id, row);
      return {
        runId: "routing-run-fallback",
        attemptId: row.id,
        modelId: row.modelId,
        startedAt: Date.now(),
        overheadMs: 0,
      };
    },
    beginRetryAttempt: async (
      _previous: unknown,
      input: { attemptIndex: number; modelId: string }
    ) => {
      const row: InstrumentationAttemptRow = {
        id: `routing-attempt-${input.attemptIndex}-${input.modelId}`,
        attemptIndex: input.attemptIndex,
        modelId: input.modelId,
        state: "draft",
      };
      instrumentationAttemptRows.set(row.id, row);
      return {
        runId: "routing-run-fallback",
        attemptId: row.id,
        modelId: row.modelId,
        startedAt: Date.now(),
        overheadMs: 0,
      };
    },
    authoriseDispatch: async (record: {
      attemptId: string;
      modelId: string;
    }) => {
      const row = instrumentationAttemptRows.get(record.attemptId);
      assert.ok(row);
      assert.equal(row.modelId, record.modelId);
      assert.equal(row.state, "draft");
      row.state = "finalized";
      return record;
    },
    recordDispatchStarted: async (record: unknown) => {
      const instrumentation = record as {
        attemptId: string;
        modelId: string;
      };
      const row = instrumentationAttemptRows.get(instrumentation.attemptId);
      assert.ok(row);
      assert.equal(row.modelId, instrumentation.modelId);
      assert.equal(row.state, "finalized");
      row.state = "dispatch_started";
      attemptLifecycle.push(`${row.attemptIndex}:dispatch_start`);
    },
    recordDispatched: async (record: unknown) => {
      recordDispatchedCalls += 1;
      const instrumentation = record as {
        attemptId: string;
        modelId: string;
      };
      const row = instrumentationAttemptRows.get(instrumentation.attemptId);
      assert.ok(row);
      assert.equal(row.modelId, instrumentation.modelId);
      assert.equal(row.state, "dispatch_started");
      row.state = "dispatched";
      if (recordDispatchedCalls === 2 && throwAfterFallbackDispatchRecord) {
        assert.equal(
          attempts.length,
          2,
          "the fallback provider boundary must precede its dispatch record"
        );
        throw new Error("DISPATCH_RECORD_TEST_FAILURE");
      }
      if (
        recordDispatchedCalls === 2 &&
        fallbackTransitionAbortAt === "during_record_dispatched"
      ) {
        abortActiveRequest();
      }
    },
    recordNotDispatched: async (record: unknown) => {
      const instrumentation = record as {
        attemptId: string;
        modelId: string;
      };
      const row = instrumentationAttemptRows.get(instrumentation.attemptId);
      assert.ok(row);
      assert.equal(row.modelId, instrumentation.modelId);
      assert.ok(
        row.state === "draft" ||
          row.state === "finalized" ||
          row.state === "dispatch_started"
      );
      closedInstrumentationAttempts.push({
        id: row.id,
        attemptIndex: row.attemptIndex,
        modelId: row.modelId,
        outcome: "not_dispatched",
      });
      row.state = "terminal";
    },
    completeInstrumentedDispatch: async (
      record: unknown,
      close: { outcome: string; firstVisibleTokenAt?: unknown }
    ) => {
      const instrumentation = record as {
        attemptId: string;
        modelId: string;
      };
      const row = instrumentationAttemptRows.get(instrumentation.attemptId);
      assert.ok(row);
      assert.equal(row.modelId, instrumentation.modelId);
      assert.equal(row.state, "dispatched");
      dispatchCloses.push({
        attemptId: instrumentation.attemptId,
        modelId: instrumentation.modelId,
        outcome: close.outcome,
        firstVisibleTokenAt: close.firstVisibleTokenAt,
      });
      closedInstrumentationAttempts.push({
        id: row.id,
        attemptIndex: row.attemptIndex,
        modelId: row.modelId,
        outcome: close.outcome,
      });
      row.state = "terminal";
    },
    recordFallbackRecovery: async () => undefined,
  },
});

/* The one timing line per turn (lib/chatTurnTiming.ts). */
const timingLines: Array<Record<string, unknown>> = [];
const realInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes('"chat_turn_timing"')) {
    timingLines.push(JSON.parse(args[0]) as Record<string, unknown>);
    return;
  }
  realInfo(...args);
};

globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

/*
  The route's structured warnings, captured so a claim it makes about itself
  can be asserted. `chat_auto_readiness_overridden` is the one that matters
  here: it is a record that a turn routed only because a drill said so, and a
  record like that is worth nothing if it is also written for turns that did
  not route.
*/
const warnings: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string") warnings.push(args[0]);
  realWarn(...(args as []));
};

const warningEvents = (event: string) =>
  warnings.filter((line) => line.includes(`"event":"${event}"`));

/* -------------------------------------------------------------------------- */
/* Driving the route                                                           */
/* -------------------------------------------------------------------------- */

type RouteModule = { POST: (request: Request) => Promise<Response> };

let routePromise: Promise<RouteModule> | null = null;

const loadRoute = async (): Promise<RouteModule> => {
  routePromise ??= (async () => {
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

/** Holds the event loop open while an `unref`ed timer is the only thing due. */
const whileWaiting = async <T,>(read: () => Promise<T>): Promise<T> => {
  const anchor = setInterval(() => {}, 20);
  try {
    return await read();
  } finally {
    clearInterval(anchor);
  }
};

const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
};

const ask = async (
  behaviour: "answers" | "silent" | "partial" | "completion_wait",
  claimMode: "claimed" | "reattach" | "reattach-completed" | "conflict" = "claimed",
  expectedStatus = 200,
  withContextBundle = false,
  requestMessages: Array<Record<string, unknown>> = [
    { id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" },
  ],
  includeSourceUserMessageId = true,
  withInjectedPrimaryFault = true,
  refinerDecision?: "accepted" | "kept_original",
  webSearchMode: "off" | "always" = "off",
  abortFallbackAt:
    | "none"
    | "after_token"
    | "during_completion"
    | "after_stream_created"
    | "during_record_dispatched"
    | "during_primary_reader_cancel" = "none"
) => {
  fallbackBehaviour = behaviour;
  injectPrimaryFault = withInjectedPrimaryFault;
  durableClaimMode = claimMode;
  attempts.length = 0;
  attemptLifecycle.length = 0;
  completionUsageRead = false;
  releasePendingCompletionUsage = () => {};
  recordDispatchedCalls = 0;
  fallbackTransitionAbortAt =
    abortFallbackAt === "after_stream_created" ||
    abortFallbackAt === "during_record_dispatched" ||
    abortFallbackAt === "during_primary_reader_cancel"
      ? abortFallbackAt
      : "none";
  dispatchCloses.length = 0;
  instrumentationAttemptRows.clear();
  closedInstrumentationAttempts.length = 0;
  timingLines.length = 0;
  world.messages = [];
  world.terminals = [];
  ledger.settlements = [];
  ledger.settledAttempts = [];
  ledger.attemptBudgetReleasesAtSettlement = [];
  ledger.releases = [];
  ledger.attemptBudgetReservations = 0;
  ledger.attemptBudgetReleases = 0;
  ledger.accessAcquisitions = 0;
  warnings.length = 0;
  durableRevision = 0;
  durableAttemptAdmissionCalls = 0;
  durableClaimCalls = 0;
  lastDurableClaimInput = null;
  messageFindFirstArgs = [];
  routerInputs.length = 0;
  shadowInputs.length = 0;

  const { POST } = await loadRoute();
  const requestAbortController = new AbortController();
  abortActiveRequest = () =>
    requestAbortController.abort("client stopped during fallback transition");
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Step 4 of the drill: the first provider fails before its first
        // chunk. Also lock 2 of the readiness override -- one credential.
        ...(withInjectedPrimaryFault
          ? { "x-tomverse-fault-injection": `${FAULT_SECRET}:attempt_0_pre_token` }
          : {}),
      },
      body: JSON.stringify({
        messages: requestMessages,
        modelId: REQUESTED_MODEL_ID,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        webSearchMode,
        ...(includeSourceUserMessageId
          ? { sourceUserMessageId: SOURCE_USER_MESSAGE_ID }
          : {}),
        ...(withContextBundle ? { contextBundle: "signed-test-bundle" } : {}),
        ...(refinerDecision ? { promptRefinerDecision: { suggestionId: REFINER_SUGGESTION_ID,
          scopeId: REFINER_SCOPE_ID, epoch: 1, decision: refinerDecision } } : {}),
      }),
      signal: requestAbortController.signal,
    })
  );
  if (response.status !== expectedStatus) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  /*
    The body read is allowed to fail, and one case needs it to.

    A turn that is not routed has no §7 recovery, so the injected fault ends
    it by erroring the response stream -- which is the correct behaviour and
    which makes `response.text()` reject. Swallowing it here keeps that case
    asserting about the record the route wrote rather than about how the
    stream ended.
  */
  const bodyDrivenAbort =
    abortFallbackAt === "after_token" ||
    abortFallbackAt === "during_completion";
  const read = bodyDrivenAbort
    ? await whileWaiting(async () => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let body = "";
        while (!body.includes(ANSWER)) {
          const { done, value } = await reader.read();
          if (done) throw new Error("fallback stream ended before its partial token");
          body += decoder.decode(value, { stream: true });
        }
        const completionRead =
          abortFallbackAt === "during_completion" ? reader.read() : null;
        if (completionRead) {
          await until("fallback completion metadata wait", () => completionUsageRead);
        }
        requestAbortController.abort("client stopped the fallback");
        releasePendingCompletionUsage();
        let streamError: unknown = null;
        try {
          if (completionRead) await completionRead;
          while (!(await reader.read()).done) {}
        } catch (error) {
          streamError = error;
        }
        return { body, streamError };
      })
    : await whileWaiting(() =>
        response.text().then(
          (body) => ({ body, streamError: null as unknown }),
          (streamError: unknown) => ({ body: "", streamError })
        )
      );
  if (abortFallbackAt !== "none") {
    await until("the aborted fallback to settle", () => ledger.settlements.length > 0);
  }
  return { response, ...read };
};

const { splitRoutingRetrySignal } = require(
  resolve(ROOT, "lib/routingRetrySignal.ts")
) as typeof import("../../lib/routingRetrySignal");
const { splitStreamKeepaliveSignal } = require(
  resolve(ROOT, "lib/chatStreamKeepalive.ts")
) as typeof import("../../lib/chatStreamKeepalive");

/* -------------------------------------------------------------------------- */

test("a routed turn whose primary dies pre-token is finished by a second model", async () => {
  const { body } = await ask("answers");

  // Exactly two provider calls: the primary, and one fallback. A third would
  // mean the turn re-routed after a swap, which §7 does not permit.
  assert.equal(
    attempts.length,
    2,
    `expected one primary and one fallback, got ${attempts.length}`
  );

  // The swap was announced, and it names the model that actually answered --
  // not the one the request was sent to.
  const routing = splitRoutingRetrySignal(body);
  assert.equal(routing.signal?.state, "retrying_with_another_model");
  assert.equal(routing.signal?.modelId, attempts[1].modelId);
  assert.notEqual(attempts[1].modelId, attempts[0].modelId);

  // And the answer is the second model's, with no marker left in it.
  const readable = splitStreamKeepaliveSignal(routing.text).text;
  assert.ok(readable.startsWith(ANSWER), JSON.stringify(readable.slice(0, 120)));

  // The primary's stream is cancelled at the swap, so it is not left open and
  // billing after another model took the turn over.
  assert.ok(attempts[0].cancelledWith, "the primary stream was left open");
  assert.ok(attempts[0].providerAbortedWith, "the primary provider was not aborted");
  assert.equal(attempts[1].providerAbortedWith, null);
  const primaryAbort = attemptLifecycle.indexOf("0:provider_abort");
  assert.ok(primaryAbort >= 0);
  assert.equal(attemptLifecycle[primaryAbort + 1], "0:reader_cancel");
});

test("request abort during fallback terminalizes the partial turn once", async () => {
  await ask(
    "partial",
    "claimed",
    200,
    false,
    [{ id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" }],
    true,
    true,
    undefined,
    "off",
    "after_token"
  );

  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].providerAbortedWith);
  assert.ok(attempts[1].providerAbortedWith);
  assert.ok(attempts[1].cancelledWith);
  assert.equal(attempts[1].providerAbortedBeforeReaderCancel, true);
  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.equal(ledger.releases.length, 1);
  assert.deepEqual(world.messages, []);
  assert.equal(world.terminals.length, 1);
  assert.equal(world.terminals[0]?.status, "cancelled");
  assert.equal(world.terminals[0]?.finishReason, "cancelled");
  assert.equal(world.terminals[0]?.finalContent, ANSWER);
});

test("request abort wins while completed provider metadata is still pending", async () => {
  await ask(
    "completion_wait",
    "claimed",
    200,
    false,
    [{ id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" }],
    true,
    true,
    undefined,
    "off",
    "during_completion"
  );

  assert.equal(completionUsageRead, true);
  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "cancelled");
  assert.equal(ledger.releases.length, 1);
  assert.deepEqual(world.messages, []);
  assert.equal(world.terminals.length, 1);
  assert.equal(world.terminals[0]?.status, "cancelled");
  assert.equal(world.terminals[0]?.finalContent, ANSWER);
});

for (const abortAt of [
  "after_stream_created",
  "during_record_dispatched",
  "during_primary_reader_cancel",
] as const) {
  test(`request abort ${abortAt} terminalizes the dispatched fallback once`, async () => {
    await ask(
      "partial",
      "claimed",
      200,
      false,
      [{ id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" }],
      true,
      true,
      undefined,
      "off",
      abortAt
    );

    assert.equal(attempts.length, 2);
    assert.ok(attempts[0].providerAbortedWith);
    assert.ok(attempts[1].providerAbortedWith);
    assert.ok(attempts[1].cancelledWith);
    assert.equal(attempts[1].providerAbortedBeforeReaderCancel, true);
    assert.deepEqual(attempts.map(({ modelId }) => modelId), [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    assert.deepEqual(
      dispatchCloses.map(({ attemptId, modelId, outcome }) => ({
        attemptId,
        modelId,
        outcome,
      })),
      [
        {
          attemptId: "routing-attempt-0-deepseek-v4-flash",
          modelId: "deepseek-v4-flash",
          outcome: "failed_pre_token",
        },
        {
          attemptId: "routing-attempt-1-deepseek-v4-pro",
          modelId: "deepseek-v4-pro",
          outcome: "cancelled",
        },
      ]
    );
    assert.deepEqual(closedInstrumentationAttempts, [
      {
        id: "routing-attempt-0-deepseek-v4-flash",
        attemptIndex: 0,
        modelId: "deepseek-v4-flash",
        outcome: "failed_pre_token",
      },
      {
        id: "routing-attempt-1-deepseek-v4-pro",
        attemptIndex: 1,
        modelId: "deepseek-v4-pro",
        outcome: "cancelled",
      },
    ]
    );
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].outcome, "cancelled");
    assert.equal(ledger.settlements[0].attempts, 2);
    assert.equal(ledger.attemptBudgetReservations, 1);
    assert.equal(ledger.attemptBudgetReleases, 0);
    assert.equal(ledger.releases.length, 1);
    assert.deepEqual(world.messages, []);
    assert.equal(world.terminals.length, 1);
    assert.equal(world.terminals[0]?.status, "cancelled");
  });
}

for (const [mode, decision] of [
  ["explicit", "accepted"], ["explicit", "kept_original"], ["auto", "accepted"],
] as const) test(`${mode} Refiner ${decision} preserves owned file context beside the execution text`, async () => {
  refinerMode = mode;
  refinerConsumes = 0;
  conversationSelectionMode = mode === "auto" ? "auto" : "manual";
  const file: MockStoredAttachment = {
    id: "refiner-bound-file", uploadId: null, userId: USER_ID,
    conversationId: CONVERSATION_ID, name: "notes.txt", mediaType: "text/plain",
    kind: "text", size: 48, objectKey: `${attachmentObjectPrefix}refiner-notes.txt`,
    unavailableAt: null, unavailableReason: null,
  };
  persistedSourceAttachments = [file];
  resolvedAttachmentRows = [file];
  syntheticR2Objects.set(file.objectKey, Buffer.from("Synthetic attachment facts: the launch date is Friday."));
  const messages = [{ id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘",
    attachments: [{ id: file.id, attachmentId: file.id, name: file.name,
      kind: file.kind, mediaType: file.mediaType, size: file.size }] }];
  const authored = structuredClone(messages);
  const expected = decision === "accepted" ? REFINER_PROMPT : messages[0].content;
  try {
    const { streamError, response } = await ask("answers", "claimed", 200, false, messages, true, false, decision);
    assert.equal(streamError, null);
    assert.equal(response.headers.get("X-Prompt-Refiner-Execution"), decision === "accepted" ? "applied" : "original");
    assert.equal(routerInputs[0].text, expected);
    assert.equal(routerInputs[0].reservedInputTokens, preflightInputEstimate([
      { ...messages[0], content: expected },
    ]).estimatedInputTokens);
    assert.equal(routerInputs[0].attachmentsUnmeasurable, false);
    assert.deepEqual(shadowInputs[0].profile, buildTaskProfile({ text: expected,
      attachments: [], webSearchRequested: false }));
    assert.equal(attempts.length, 1);
    const content = attempts[0].messages.at(-1)!.content;
    const text = typeof content === "string" ? content
      : (content as Array<{ type: string; text?: string }>).filter(part => part.type === "text").map(part => part.text).join("");
    assert.ok(text.startsWith(expected), "the provider starts with the same verified user execution text");
    assert.ok(text.includes("Synthetic attachment facts: the launch date is Friday."));
    assert.ok(text.includes("<<<ATTACHED_FILE>>>"));
    assert.deepEqual(messages, authored);
    assert.deepEqual(persistedSourceAttachments, [file]);
    assert.equal(refinerConsumes, 1);
    assert.equal(ledger.accessAcquisitions, 1);
  } finally {
    persistedSourceAttachments = [];
    resolvedAttachmentRows = [];
    syntheticR2Objects.clear();
    refinerMode = null;
    conversationSelectionMode = "auto";
  }
});

test("an Auto Refiner search turn profiles and dispatches the verified execution text once", async () => {
  refinerMode = "auto";
  refinerConsumes = 0;
  try {
    const { streamError } = await ask("answers", "claimed", 200, false, undefined, true, false, "accepted", "always");
    assert.equal(streamError, null);
    assert.equal(routerInputs[0].text, REFINER_PROMPT);
    assert.equal(shadowInputs[0].profile.needsCurrentInformation, true);
    assert.equal(attempts.length, 1);
    const content = attempts[0].messages.at(-1)!.content;
    const text = typeof content === "string" ? content
      : (content as Array<{ type: string; text?: string }>).filter(part => part.type === "text").map(part => part.text).join("");
    assert.equal(text, REFINER_PROMPT);
    assert.equal(refinerConsumes, 1);
    assert.equal(ledger.accessAcquisitions, 1);
  } finally {
    refinerMode = null;
  }
});

test("the first visible token belongs to the attempt that answered, not the one that died", async () => {
  await ask("answers");
  assert.equal(attempts.length, 2);

  // The primary failed before any chunk: its close carries no first token, so
  // the Router's per-model TTFT signal is never handed a time for it.
  const primary = dispatchCloses.find((close) => close.outcome === "failed_pre_token");
  assert.ok(primary, "the failed primary was never closed");
  assert.equal(primary.firstVisibleTokenAt ?? null, null);

  // The attempt that answered carries the moment its first chunk went out.
  const answered = dispatchCloses.find((close) => close.outcome === "succeeded");
  assert.ok(answered, "the answering attempt was never closed");
  assert.ok(answered.firstVisibleTokenAt instanceof Date);

  // One timing line for the turn, naming the model that answered.
  assert.equal(timingLines.length, 1);
  assert.equal(timingLines[0].outcome, "completed");
  assert.equal(timingLines[0].firstVisibleChunkSent, true);
  assert.equal(timingLines[0].modelId, attempts[1].modelId);
});

test("an exact durable replay reattaches without reservation or provider dispatch", async () => {
  const { response, body } = await ask("answers", "reattach");
  assert.equal(response.headers.get("X-Chat-Response-Mode"), "durable-attempt");
  assert.equal(attempts.length, 0);
  assert.equal(ledger.accessAcquisitions, 0);
  const payload = JSON.parse(body) as { attempt: Record<string, unknown> };
  assert.equal(payload.attempt.assistantMessageId, ASSISTANT_MESSAGE_ID);
  assert.equal("fingerprint" in payload.attempt, false);
  assert.equal("ownerId" in payload.attempt, false);
  assert.equal("leaseExpiresAt" in payload.attempt, false);
});

test("a completed durable replay includes its canonical public Message", async () => {
  const { response, body } = await ask("answers", "reattach-completed");
  assert.equal(response.headers.get("X-Chat-Response-Mode"), "durable-attempt");
  assert.equal(attempts.length, 0);
  assert.equal(ledger.accessAcquisitions, 0);
  const payload = JSON.parse(body) as {
    attempt: Record<string, unknown>;
    message: Record<string, unknown>;
  };
  assert.equal(payload.attempt.status, "completed");
  assert.equal(payload.message.id, ASSISTANT_MESSAGE_ID);
  assert.equal(payload.message.content, "Recovered canonical answer.");
  assert.equal(payload.message.memoryUsedCount, 2);
  assert.equal(payload.message.knowledgeChunkCount, 1);
  assert.equal(JSON.stringify(payload).includes("providerContext"), false);
});

test("durable claim and reattach POSTs are throttled before source or attempt storage", async () => {
  durableAttemptAdmissionRefused = true;
  try {
    const claimed = await ask("answers", "claimed", 429);
    assert.equal((JSON.parse(claimed.body) as { code?: string }).code, "API_RATE_LIMITED");
    assert.equal(durableAttemptAdmissionCalls, 1);
    assert.equal(durableClaimCalls, 0);
    assert.equal(ledger.accessAcquisitions, 0);
    assert.equal(attempts.length, 0);

    const reattach = await ask("answers", "reattach", 429);
    assert.equal((JSON.parse(reattach.body) as { code?: string }).code, "API_RATE_LIMITED");
    assert.equal(durableAttemptAdmissionCalls, 1);
    assert.equal(durableClaimCalls, 0);
    assert.equal(ledger.accessAcquisitions, 0);
    assert.equal(attempts.length, 0);
  } finally {
    durableAttemptAdmissionRefused = false;
  }
});

test("a durable identity mismatch is one generic 409 without dispatch", async () => {
  const { body } = await ask("answers", "conflict", 409);
  assert.equal(attempts.length, 0);
  assert.equal(ledger.accessAcquisitions, 0);
  const payload = JSON.parse(body) as Record<string, unknown>;
  assert.equal(payload.code, "CHAT_ATTEMPT_ID_REUSED");
  assert.equal("fingerprint" in payload, false);
});

test("a past source id plus a newer user payload is rejected before paid work", async () => {
  const { body } = await ask("answers", "claimed", 409, false, [
    { id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" },
    {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      role: "user",
      content: "new payload",
    },
  ]);
  assert.equal(attempts.length, 0);
  assert.equal(ledger.accessAcquisitions, 0);
  assert.equal(world.terminals.length, 0);
  const payload = JSON.parse(body) as Record<string, unknown>;
  assert.equal(payload.code, "CHAT_SOURCE_MESSAGE_MISMATCH");
  assert.equal("sourceUserMessageId" in payload, false);
});

test("a restored client attachment uses the current bound row id, not its provenance id", async () => {
  const current: MockStoredAttachment = {
    id: "bound-current-row",
    uploadId: "original-upload",
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    name: "same.txt",
    mediaType: "text/plain",
    size: 12,
    kind: "text",
    objectKey: `${attachmentObjectPrefix}same.txt`,
    unavailableAt: null,
    unavailableReason: null,
  };
  const sameMetadataOtherRow: MockStoredAttachment = {
    ...current,
    id: "other-bound-row",
    uploadId: "other-upload",
    objectKey: `${attachmentObjectPrefix}same-copy.txt`,
  };
  persistedSourceAttachments = [current];
  resolvedAttachmentRows = [current, sameMetadataOtherRow];
  try {
    const restoredAttachment = {
      id: "bound-current-row",
      attachmentId: "bound-current-row",
      name: "same.txt",
      mediaType: "text/plain",
      size: 12,
      kind: "text",
    };
    const exact = await ask("answers", "reattach", 200, false, [{
      id: SOURCE_USER_MESSAGE_ID,
      role: "user",
      content: "이 질문에 답해 줘",
      attachments: [restoredAttachment],
    }]);
    assert.equal(exact.response.headers.get("X-Chat-Response-Mode"), "durable-attempt");
    assert.equal(ledger.accessAcquisitions, 0);
    assert.equal(attempts.length, 0);

    const mismatched = await ask("answers", "claimed", 409, false, [{
      id: SOURCE_USER_MESSAGE_ID,
      role: "user",
      content: "이 질문에 답해 줘",
      attachments: [{ ...restoredAttachment, id: "other-bound-row", attachmentId: "other-bound-row" }],
    }]);
    assert.equal((JSON.parse(mismatched.body) as { code?: string }).code, "CHAT_SOURCE_MESSAGE_MISMATCH");
    assert.equal(ledger.accessAcquisitions, 0);
    assert.equal(attempts.length, 0);
  } finally {
    persistedSourceAttachments = [];
    resolvedAttachmentRows = [];
  }
});

test("a post-claim context consumption collision is terminal and dispatch-free", async () => {
  contextConsumeSucceeds = false;
  try {
    const { response, body } = await ask("answers", "claimed", 409, true);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(attempts.length, 0);
    assert.equal(ledger.accessAcquisitions, 0);
    assert.equal(world.terminals.length, 1);
    assert.equal(world.terminals[0]?.status, "failed");
    assert.equal(world.terminals[0]?.failureCode, "request_refused");
    const payload = JSON.parse(body) as Record<string, unknown>;
    assert.equal(payload.code, "CHAT_CONTEXT_BUNDLE_STALE");
    assert.deepEqual(payload.details, {
      requiresPreflight: true,
      refusalReason: "already_consumed",
    });
    assert.equal("bundleId" in payload, false);
  } finally {
    contextConsumeSucceeds = true;
  }
});

test("a pre-durable browser request id derives and verifies one scoped durable source", async () => {
  const legacyRequestId = "99999999-8888-4777-8666-555555555555";
  const { scopedMessageId } = require(
    resolve(ROOT, "lib/messageRequestIdentity.ts")
  ) as typeof import("../../lib/messageRequestIdentity");
  const expectedSourceId = scopedMessageId(CONVERSATION_ID, legacyRequestId);

  await ask(
    "answers",
    "reattach",
    200,
    false,
    [{ id: legacyRequestId, role: "user", content: "이 질문에 답해 줘" }],
    false
  );

  assert.equal(durableAttemptAdmissionCalls, 1);
  assert.equal(durableClaimCalls, 1);
  assert.equal(lastDurableClaimInput?.sourceUserMessageId, expectedSourceId);
  assert.equal(
    (messageFindFirstArgs[0]?.where as { id?: string } | undefined)?.id,
    expectedSourceId
  );
});

test("a non-durable persisted answer resolves the latest prompt deterministically", async () => {
  conversationProductKey = "review";
  try {
    await ask(
      "answers",
      "claimed",
      200,
      false,
      [{ id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" }],
      false,
      false
    );
    const persistenceLookup = messageFindFirstArgs.find((args) =>
      Array.isArray(args.orderBy)
    );
    assert.ok(
      persistenceLookup,
      `missing deterministic persistence lookup: ${JSON.stringify(messageFindFirstArgs)}`
    );
    assert.deepEqual(persistenceLookup?.orderBy, [
      { createdAt: "desc" },
      { id: "desc" },
    ]);
    assert.equal(
      "id" in ((persistenceLookup?.where ?? {}) as Record<string, unknown>),
      false
    );
  } finally {
    conversationProductKey = "chat";
  }
});

test("the answer is persisted against the model that produced it", async () => {
  await ask("answers");

  assert.equal(world.messages.length, 1);
  assert.equal(
    world.messages[0].modelId,
    attempts[1].modelId,
    "the assistant message named the model that wrote none of it"
  );
});

test("a fallback settles once, releases once, and holds once more", async () => {
  await ask("answers");

  // One settlement for the turn, carrying both attempts -- the primary's
  // failed attempt is closed into it rather than settled separately.
  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "completed");
  assert.equal(
    ledger.settlements[0].attempts,
    2,
    "a multi-attempt turn must settle as two attempts, not one"
  );

  // One lease, released once. The swap does not take a second slot.
  assert.equal(ledger.releases.length, 1);
  assert.equal(ledger.releases[0].leaseId, "lease-fallback-1");

  // The fallback authorised its own provider hold and kept it, because the
  // dispatch it paid for happened.
  assert.equal(ledger.attemptBudgetReservations, 1);
  assert.equal(ledger.attemptBudgetReleases, 0);

  for (const index of [0, 1]) {
    assert.ok(
      attemptLifecycle.indexOf(`${index}:dispatch_start`) <
        attemptLifecycle.indexOf(`${index}:provider_start`),
      `attempt ${index} reached its provider before the durable start record`
    );
  }

  // Both provider streams are accounted for: the primary cancelled at the
  // swap, the fallback closed by finishing.
  assert.ok(attempts[0].cancelledWith);
});

test("a post-invocation dispatch record failure keeps the fallback hold and settlement", async () => {
  throwAfterFallbackDispatchRecord = true;
  try {
    const { body, streamError } = await ask("answers");

    assert.equal(streamError, null);
    assert.ok(body.includes(ANSWER));
    assert.equal(attempts.length, 2, "the recording failure triggered another dispatch");
    assert.equal(recordDispatchedCalls, 2);
    assert.equal(ledger.attemptBudgetReservations, 1);
    assert.equal(
      ledger.attemptBudgetReleases,
      0,
      "a provider invocation was misclassified as an abandoned hold"
    );
    assert.deepEqual(ledger.settlements, [{ outcome: "completed", attempts: 2 }]);
    assert.deepEqual(ledger.settledAttempts, [
      { attemptIndex: 0, modelId: attempts[0].modelId },
      { attemptIndex: 1, modelId: attempts[1].modelId },
    ]);
    assert.deepEqual(ledger.attemptBudgetReleasesAtSettlement, [0]);
    assert.deepEqual(ledger.releases, [{ leaseId: "lease-fallback-1" }]);
    assert.deepEqual(
      closedInstrumentationAttempts.map(({ attemptIndex, modelId, outcome }) => ({
        attemptIndex,
        modelId,
        outcome,
      })),
      [
        { attemptIndex: 0, modelId: attempts[0].modelId, outcome: "failed_pre_token" },
        { attemptIndex: 1, modelId: attempts[1].modelId, outcome: "succeeded" },
      ]
    );
  } finally {
    throwAfterFallbackDispatchRecord = false;
  }
});

test("a fallback constructor failure releases its unspent hold without a third dispatch", async () => {
  throwBeforeFallbackStreamReturn = true;
  try {
    await ask("answers");

    assert.equal(attempts.length, 1, "a constructor failure reached the fallback provider");
    assert.equal(recordDispatchedCalls, 1);
    assert.equal(ledger.attemptBudgetReservations, 1);
    assert.equal(ledger.attemptBudgetReleases, 1);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].outcome, "failed");
    assert.equal(ledger.releases.length, 1);
    assert.ok(attemptLifecycle.includes("1:dispatch_start"));
    assert.equal(attemptLifecycle.includes("1:provider_start"), false);
    assert.deepEqual(
      closedInstrumentationAttempts
        .map(({ attemptIndex, modelId, outcome }) => ({
          attemptIndex,
          modelId,
          outcome,
        }))
        .sort((left, right) => left.attemptIndex - right.attemptIndex),
      [
        { attemptIndex: 0, modelId: attempts[0].modelId, outcome: "failed_pre_token" },
        { attemptIndex: 1, modelId: "deepseek-v4-pro", outcome: "not_dispatched" },
      ]
    );
  } finally {
    throwBeforeFallbackStreamReturn = false;
  }
});

test("assistant Message transaction failure settles once and terminalizes immediately", async () => {
  failAssistantPersistence = true;
  try {
    const { streamError } = await ask("answers");
    assert.ok(streamError, "the failed local persistence must fail the published stream");
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].outcome, "completed");
    assert.equal(world.messages.length, 0);
    assert.equal(world.terminals.length, 1);
    assert.equal(world.terminals[0]?.status, "failed");
    assert.equal(world.terminals[0]?.failureCode, "internal_error");
  } finally {
    failAssistantPersistence = false;
  }
});

test("a failed durable terminal write cannot skip financial settlement", async () => {
  durableTerminalFails = true;
  try {
    await ask("silent");
    assert.equal(world.terminals.length, 1);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].outcome, "failed");
  } finally {
    durableTerminalFails = false;
  }
});

/* ------------------------------------------- the liveness watch, across both */

test("the keepalive keeps writing after the swap, and the deadline still owns the turn", async () => {
  // The fallback opens its stream and never writes. If the first-token watch
  // stopped at the swap, nothing would end this turn; if the deadline were
  // restarted by the swap it would still end, but the keepalives would not
  // continue across it. Both claims were made by construction until now.
  const { body } = await ask("silent");

  assert.equal(attempts.length, 2);

  const markerIndex = body.indexOf("TOMVERSE_ROUTING_RETRY");
  assert.ok(markerIndex >= 0, "the swap was never announced");

  const afterSwap = body.slice(markerIndex);
  const keepalivesAfterSwap =
    afterSwap.split("TOMVERSE_STREAM_KEEPALIVE").length - 1;
  assert.ok(
    keepalivesAfterSwap >= 1,
    "the connection went silent once the fallback took over, which is the " +
      "window the edge closes it in"
  );

  // The turn ended on the first-token deadline, not on a provider error: the
  // watch was still the thing holding it.
  const keepalive = splitStreamKeepaliveSignal(body);
  assert.equal(keepalive.signal?.state, "stalled");
  assert.equal(keepalive.signal?.code, "CHAT_FIRST_RESPONSE_TIMEOUT");

  // Nothing readable reached the user: neither attempt produced a token.
  assert.equal(splitRoutingRetrySignal(keepalive.text).text, "");
});

test("a stall after the swap cancels the fallback's stream, settles and releases once", async () => {
  await ask("silent");

  // The fallback's own reader is cancelled by the deadline -- the primary's
  // was already cancelled by the swap, so both are accounted for exactly once.
  assert.ok(attempts[0].cancelledWith, "the primary stream was left open");
  assert.ok(attempts[1].cancelledWith, "the fallback stream was left open");

  assert.equal(ledger.settlements.length, 1);
  assert.equal(ledger.settlements[0].outcome, "failed");
  assert.equal(ledger.releases.length, 1);

  // No answer existed, so no assistant message may be written for one.
  assert.deepEqual(world.messages, []);
});

/* ------------------------------------- what the override record may claim */

for (const [mode, decision] of [
  ["explicit", "accepted"], ["explicit", "kept_original"], ["auto", "accepted"],
] as const) test(`${mode} Refiner ${decision} preserves pinned response and execution notice`, async () => {
  refinerMode = mode;
  refinerConsumes = 0;
  conversationSelectionMode = mode === "auto" ? "auto" : "manual";
  pinnedResponse = new Response("Pinned synthetic answer.", { status: 202,
    headers: { "X-Pinned-Receipt": "synthetic", "Set-Cookie": "synthetic=1; Path=/; HttpOnly" } });
  const messages = [{ id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" }];
  const authored = structuredClone(messages);
  try {
    const { response, body, streamError } = await ask("answers", "claimed", 202, false, messages, true, false, decision);
    assert.equal(streamError, null);
    assert.equal(body, "Pinned synthetic answer.");
    assert.equal(response.headers.get("X-Pinned-Receipt"), "synthetic");
    assert.ok(response.headers.get("Set-Cookie")?.includes("synthetic=1"));
    assert.equal(response.headers.get("X-Prompt-Refiner-Execution"), decision === "accepted" ? "applied" : "original");
    assert.equal(response.headers.get("X-Prompt-Refiner-Mode"), mode);
    assert.equal(refinerConsumes, 1);
    assert.deepEqual(pinnedInputs, [{ ...messages[0], content: decision === "accepted" ? REFINER_PROMPT : messages[0].content }]);
    assert.deepEqual(messages, authored);
    assert.equal(attempts.length, 0, "the successful pinned dispatch does not fall through to another provider");
  } finally {
    pinnedResponse = null;
    pinnedInputs = null;
    refinerMode = null;
    conversationSelectionMode = "auto";
  }
});

test("a routed drill turn is recorded as overridden, exactly once", async () => {
  await ask("answers");

  const overridden = warningEvents("chat_auto_readiness_overridden");
  assert.equal(overridden.length, 1);
  assert.ok(overridden[0].includes('"reason":"staging_drill_override"'));
  // It names the model that was actually chosen, so the record says what the
  // override bought rather than only that it happened.
  assert.ok(overridden[0].includes('"selectedModelId"'));
});

test("a turn the override did not route records no override at all", async () => {
  // The same credential, the same account, the same outstanding gate -- and a
  // manual conversation, which the override does not and must not carry past.
  //
  // This is the regression for where the record is written. It used to be
  // written beside the cohort read, which happens before the selection: every
  // turn with a valid drill credential was recorded as an overridden routing
  // decision, including the ones that then routed nothing.
  conversationSelectionMode = "manual";
  try {
    const { body, streamError } = await ask("answers");

    assert.deepEqual(warningEvents("chat_auto_readiness_overridden"), []);
    // Not routed, so §7 never applies: one attempt, and the injected fault
    // ends the turn rather than being recovered from.
    assert.equal(attempts.length, 1);
    assert.ok(streamError, "an unrouted turn has no recovery, so the stream errors");
    assert.equal(splitRoutingRetrySignal(body).signal, null);
  } finally {
    conversationSelectionMode = "auto";
  }
});

for (const [mode, decision] of [
  ["explicit", "accepted"], ["explicit", "kept_original"], ["auto", "accepted"],
] as const) test(`${mode} Refiner ${decision} uses one execution prompt at Router, shadow and provider`, async () => {
  refinerMode = mode;
  refinerConsumes = 0;
  conversationSelectionMode = mode === "auto" ? "auto" : "manual";
  const messages = [
    { id: "history-user", role: "user", content: "Earlier authored question." },
    { id: "history-assistant", role: "assistant", content: "Earlier answer." },
    { id: SOURCE_USER_MESSAGE_ID, role: "user", content: "이 질문에 답해 줘" },
  ];
  const authored = structuredClone(messages);
  const expectedPrompt = decision === "accepted" ? REFINER_PROMPT : messages.at(-1)!.content;
  try {
    const { body, streamError, response } = await ask("answers", "claimed", 200, false, messages, true, false, decision);
    assert.equal(streamError, null);
    assert.ok(body.startsWith(ANSWER));
    assert.equal(refinerConsumes, 1);
    assert.equal(response.headers.get("X-Prompt-Refiner-Execution"), decision === "accepted" ? "applied" : "original");
    assert.equal(response.headers.get("X-Prompt-Refiner-Mode"), mode);
    assert.equal(ledger.accessAcquisitions, 1);
    assert.equal(attempts.length, 1, "Refiner admission does not send another turn or enable provider retry");
    assert.equal(durableAttemptAdmissionCalls, 1);
    assert.equal(routerInputs.length, 1);
    assert.equal(routerInputs[0].text, expectedPrompt);
    assert.equal(routerInputs[0].reservedInputTokens, preflightInputEstimate([
      ...messages.slice(0, -1), { ...messages.at(-1)!, content: expectedPrompt },
    ]).estimatedInputTokens);
    assert.equal(shadowInputs.length, 1, "pending Auto readiness does not become a routed production turn");
    assert.deepEqual(shadowInputs[0].profile, buildTaskProfile({ text: expectedPrompt, attachments: [], webSearchRequested: false }));
    const text = (content: unknown) => typeof content === "string" ? content
      : (content as Array<{ type: string; text?: string }>).filter(part => part.type === "text").map(part => part.text).join("");
    const providerMessages = attempts[0].messages.filter(message => message.role !== "system");
    assert.equal(text(providerMessages.at(-1)!.content), expectedPrompt);
    assert.equal(text(providerMessages[0].content), messages[0].content);
    assert.equal(text(providerMessages[1].content), messages[1].content);
    assert.deepEqual(messages, authored, "the authored transcript remains unchanged through the streamed answer");
    assert.ok(messageFindFirstArgs.some(args => (args.where as { id?: string }).id === SOURCE_USER_MESSAGE_ID),
      "durable source verification still checks the original stored Message");
    assert.equal(warningEvents("chat_auto_readiness_overridden").length, 0);
  } finally {
    refinerMode = null;
    conversationSelectionMode = "auto";
  }
});
