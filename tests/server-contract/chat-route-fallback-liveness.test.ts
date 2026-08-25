import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import * as aiModule from "ai";

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
const REQUESTED_MODEL_ID = "claude-haiku-4-5";
const ANSWER = "The second model finished the answer.";

/** Milliseconds. Chosen the same way the keepalive file's are -- see there. */
const KEEPALIVE_INTERVAL_MS = 25;
const FIRST_TOKEN_DEADLINE_MS = 1_500;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
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

/* -------------------------------------------------------------------------- */
/* The provider streams these two attempts get                                 */
/* -------------------------------------------------------------------------- */

type Attempt = {
  /** The model id `streamText` was asked for. */
  modelId: string | null;
  /** Whether its stream was cancelled, and with what. */
  cancelledWith: unknown;
};

const attempts: Attempt[] = [];

/**
 * What the second attempt does.
 *
 * `"answers"` is the ordinary §7 recovery. `"silent"` opens its stream and
 * never writes, which is how the absolute first-token deadline is observed
 * spanning the swap.
 */
let fallbackBehaviour: "answers" | "silent" = "answers";

mock.module("ai", {
  namedExports: {
    ...aiModule,
    streamText: (options: Record<string, unknown>) => {
      const attempt: Attempt = {
        modelId:
          (options.model as { modelId?: string } | undefined)?.modelId ?? null,
        cancelledWith: null,
      };
      attempts.push(attempt);
      const index = attempts.length - 1;
      // Attempt 0 is failed by the injected fault, not by this stream: the
      // route wraps the reader in `faultedReader`, which is the drill's own
      // mechanism rather than a shape invented here.
      const silent = index > 0 && fallbackBehaviour === "silent";

      return {
        textStream: new ReadableStream<string>({
          start(controller) {
            if (index === 0 || silent) return;
            controller.enqueue(ANSWER);
            controller.close();
          },
          cancel(reason) {
            attempt.cancelledWith = reason ?? "cancelled";
          },
        }),
        response: Promise.resolve({
          id: `resp-fallback-${index}`,
          modelId: attempt.modelId,
          headers: {},
          messages: [],
        }),
        usage: Promise.resolve({
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
        }),
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

/*
  `selectionMode: "auto"` is what makes this a routed turn rather than a manual
  one, and `productKey: "chat"` is what lets it be routed at all --
  `lib/autoProductBoundary.ts` refuses Review and Studio before the cohort is
  ever consulted.
*/
let conversationSelectionMode: "auto" | "manual" = "auto";

const conversationRow = () => ({
  id: CONVERSATION_ID,
  userId: USER_ID,
  password: null,
  selectedModels: JSON.stringify([REQUESTED_MODEL_ID]),
  kind: "chat",
  productKey: "chat",
  selectionMode: conversationSelectionMode,
});

const OVERRIDES: Record<string, Record<string, (args: never) => unknown>> = {
  conversation: {
    findUnique: () => conversationRow(),
    findFirst: () => conversationRow(),
  },
  message: {
    findFirst: () => ({ id: "user-message-1" }),
    create: (args: {
      data: { id: string; status: string; modelId: string };
    }) => {
      world.messages.push({
        id: args.data.id,
        status: args.data.status,
        modelId: args.data.modelId,
      });
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
  settlements: [] as Array<{ outcome: string; attempts: number | null }>,
  releases: [] as Array<{ leaseId: string }>,
  attemptBudgetReservations: 0,
  attemptBudgetReleases: 0,
};

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => ({
      leaseId: "lease-fallback-1",
      setCookie: undefined,
      usageReservation: reservation,
    }),
    releaseChatAccess: async (leaseId: string) => {
      ledger.releases.push({ leaseId });
    },
    heartbeatChatAccess: async () => true,
    settleChatUsage: async (
      _reservation: unknown,
      usage: { outcome?: string },
      extra?: { attempts?: unknown[] }
    ) => {
      ledger.settlements.push({
        outcome: usage?.outcome ?? "unknown",
        attempts: extra?.attempts ? extra.attempts.length : null,
      });
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
    getUserBillingPlan: async () => ({ tier: "Pro", status: "active" }),
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

const ask = async (behaviour: "answers" | "silent") => {
  fallbackBehaviour = behaviour;
  attempts.length = 0;
  world.messages = [];
  ledger.settlements = [];
  ledger.releases = [];
  ledger.attemptBudgetReservations = 0;
  ledger.attemptBudgetReleases = 0;
  warnings.length = 0;

  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Step 4 of the drill: the first provider fails before its first
        // chunk. Also lock 2 of the readiness override -- one credential.
        "x-tomverse-fault-injection": `${FAULT_SECRET}:attempt_0_pre_token`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "이 질문에 답해 줘" }],
        modelId: REQUESTED_MODEL_ID,
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
      }),
    })
  );
  if (response.status !== 200) {
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
  const read = await whileWaiting(() =>
    response.text().then(
      (body) => ({ body, streamError: null as unknown }),
      (streamError: unknown) => ({ body: "", streamError })
    )
  );
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

  // Both provider streams are accounted for: the primary cancelled at the
  // swap, the fallback closed by finishing.
  assert.ok(attempts[0].cancelledWith);
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
