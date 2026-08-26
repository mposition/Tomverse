import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Three routes price the same turn, and all three must price its search the
// same way.
//
// A provider-native search is billed per query on top of tokens. The chat
// route reserved that cost; `/api/chat/preflight` and `/api/chat/availability`
// did not. So a comparison was admitted, and a composer told the user the
// request was runnable, against a provider budget that counted only the token
// half -- and the request they then sent was measured against the whole thing.
// A pre-check that computes less than the thing it is checking is not a
// pre-check.
//
// This drives the real handlers and captures what each one hands
// `createChatBudget`. What is asserted is the `nativeSearch` authorization:
// present on all three, identical, and equal to what `reserveNativeSearchCost`
// computes for the same model.

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

type NativeSearchAuthorization = {
  reservedCostMicroUsd: number;
  costPerQueryMicroUsd: number;
  maxQueries: number;
};

type BudgetCall = {
  modelId: string;
  nativeSearchEnabled: boolean;
  nativeSearch: NativeSearchAuthorization | undefined;
};

const budgetCalls: BudgetCall[] = [];
const SESSION_USER_ID = "cost-parity-user";
/** Guest by default: the reservation under test is not plan-dependent. */
let session: unknown = null;

const original = (relativePath: string) =>
  require(resolve(ROOT, relativePath)) as Record<string, unknown>;

const realChatSecurity = original("lib/chatSecurity.ts");
const realApiSecurity = original("lib/apiSecurity.ts");
const realTurnstile = original("lib/turnstile.ts");
const realBilling = original("lib/billingEntitlements.ts");

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    createChatBudget: (
      kind: unknown,
      model: { id?: string },
      estimatedInput: unknown,
      options?: {
        nativeSearchEnabled?: boolean;
        nativeSearch?: NativeSearchAuthorization;
      }
    ) => {
      budgetCalls.push({
        modelId: model?.id ?? "unknown",
        nativeSearchEnabled: options?.nativeSearchEnabled === true,
        // Only the three fields the authorization is: the chat route passes
        // the whole `NativeSearchReservation`, which also carries its `ok`
        // discriminant, and `createChatBudget` reads exactly these.
        nativeSearch: options?.nativeSearch
          ? {
              reservedCostMicroUsd: options.nativeSearch.reservedCostMicroUsd,
              costPerQueryMicroUsd: options.nativeSearch.costPerQueryMicroUsd,
              maxQueries: options.nativeSearch.maxQueries,
            }
          : undefined,
      });
      return (
        realChatSecurity.createChatBudget as (
          a: unknown,
          b: unknown,
          c: unknown,
          d: unknown
        ) => unknown
      )(kind, model, estimatedInput, options);
    },
    // Reached after the budget on every route here. Throwing keeps the test
    // off any path that would reserve credits or take a concurrency slot,
    // while leaving everything before it real.
    acquireChatAccess: () => {
      throw new Error("acquireChatAccess is not part of this contract");
    },
    preflightChatComparisonAccess: () => {
      throw new Error(
        "preflightChatComparisonAccess is not part of this contract"
      );
    },
  },
});

// Reaching the provider means a request was about to be issued. Nothing in
// this contract needs one, and the budget -- which is what is under test --
// is computed well before it.
mock.module("ai", {
  namedExports: {
    streamText: () => {
      throw new Error("streamText must not be reached by this contract");
    },
    stepCountIs: () => () => true,
    tool: (definition: unknown) => definition,
  },
});

// Database writes, and this suite runs without a database.
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
});
mock.module(mod("lib/turnstile.ts"), {
  namedExports: { ...realTurnstile, ensureGuestVerified: async () => undefined },
});

// `/api/chat/availability` resolves the account's plan before it budgets
// anything, and that read needs rows this suite has no database for. The plan
// itself is not what is under test; every route here budgets the same way for
// every tier.
mock.module(mod("lib/billingEntitlements.ts"), {
  namedExports: {
    ...realBilling,
    getUserBillingPlan: async () => ({
      tier: "Max",
      dailyMessageLimit: 2_000,
      monthlyMessageLimit: 40_000,
    }),
  },
});

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => session },
});

const MODEL_ID = "gpt-5-6-luna";
/**
 * Anthropic's native search, whose ceiling rides on the tool rather than on
 * the request -- reserved by the same rule, at its own ceiling.
 */
const ANTHROPIC_MODEL_ID = "claude-haiku-4-5";
/** Native, paid per query, and bounded by nothing. Guest-tier, like the others. */
const UNBOUNDED_MODEL_ID = "gemini-2-5-flash";

const expectedAuthorization = async (
  modelId: string = MODEL_ID
): Promise<NativeSearchAuthorization> => {
  const { reserveNativeSearchCost } = (await import(
    mod("lib/webSearchNativeCostReservation.ts")
  )) as typeof import("../../lib/webSearchNativeCostReservation");
  const { getWebSearchCapability } = (await import(
    mod("lib/webSearchCapability.ts")
  )) as typeof import("../../lib/webSearchCapability");
  const { getRuntimeModels } = (await import(
    mod("lib/modelRegistry.ts")
  )) as typeof import("../../lib/modelRegistry");
  const model = (await getRuntimeModels()).find(
    (candidate) => candidate.id === modelId
  );
  assert.ok(model, `${modelId} must be in the runtime catalogue`);
  const reservation = reserveNativeSearchCost({
    model,
    capability: getWebSearchCapability(modelId),
    nativeSearchEnabled: true,
  });
  assert.equal(reservation.ok, true, `${modelId}'s search must be reservable`);
  assert.ok(reservation.ok);
  return {
    reservedCostMicroUsd: reservation.reservedCostMicroUsd,
    costPerQueryMicroUsd: reservation.costPerQueryMicroUsd,
    maxQueries: reservation.maxQueries,
  };
};

const chatRoute = async () =>
  (await import(`${mod("app/api/chat/route.ts")}?parity=cached`)) as {
    POST: (request: Request) => Promise<Response>;
  };
const preflightRoute = async () =>
  (await import(
    `${mod("app/api/chat/preflight/route.ts")}?parity=cached`
  )) as { POST: (request: Request) => Promise<Response> };
const availabilityRoute = async () =>
  (await import(
    `${mod("app/api/chat/availability/route.ts")}?parity=cached`
  )) as { POST: (request: Request) => Promise<Response> };

const jsonRequest = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:3100${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Request-ID": "3d4b1a90-1c7e-4a02-8f55-7d1c9b0e2a44",
    },
    body: JSON.stringify(body),
  });

/** Runs a handler that is expected to blow up at the seam past the budget. */
const budgetsFor = async (
  run: () => Promise<Response>
): Promise<BudgetCall[]> => {
  budgetCalls.length = 0;
  // Every route here fails somewhere past the budget -- at the provider, or
  // at a database this suite does not have -- and that is fine: the budget is
  // computed first, and it is the whole contract.
  await run().catch(() => undefined);
  return [...budgetCalls];
};

test("the chat route reserves Luna's search at its enforced ceiling", async () => {
  const expected = await expectedAuthorization();
  const { POST } = await chatRoute();
  // A guest: the route reaches the budget without an account row, and the
  // reservation under test is not plan-dependent.
  session = null;
  const calls = await budgetsFor(() =>
    POST(
      jsonRequest("/api/chat", {
        messages: [{ role: "user", content: "what happened today?" }],
        model: MODEL_ID,
        webSearchMode: "always",
      })
    )
  );
  const luna = calls.find((call) => call.modelId === MODEL_ID);
  assert.ok(luna, "the chat route never budgeted the model under test");
  assert.equal(luna.nativeSearchEnabled, true);
  assert.deepEqual(luna.nativeSearch, expected);
  assert.ok(
    expected.reservedCostMicroUsd > 0,
    "a searching turn must reserve more than its tokens"
  );
});

const NO_SEARCH: NativeSearchAuthorization = {
  reservedCostMicroUsd: 0,
  costPerQueryMicroUsd: 0,
  maxQueries: 0,
};

/**
 * Three guest-tier models, one per native-search shape:
 * OpenAI (ceiling on the request), Anthropic (ceiling on the tool) and Google
 * (no ceiling anywhere). A guest can select all three, which is what lets one
 * comparison exercise the whole matrix.
 */
const GUEST_TRIO = [MODEL_ID, ANTHROPIC_MODEL_ID, UNBOUNDED_MODEL_ID];

test("preflight reserves exactly what the chat route reserves", async () => {
  const openAi = await expectedAuthorization(MODEL_ID);
  const anthropic = await expectedAuthorization(ANTHROPIC_MODEL_ID);
  const { POST } = await preflightRoute();
  session = null;
  const calls = await budgetsFor(() =>
    POST(
      jsonRequest("/api/chat/preflight", {
        comparisonId: "1754000000000",
        conversationId: "private-chat",
        modelIds: [MODEL_ID, ANTHROPIC_MODEL_ID],
        prompt: "what happened today?",
        attachments: [],
        webSearchMode: "always",
      })
    )
  );
  const luna = calls.find((call) => call.modelId === MODEL_ID);
  assert.ok(luna, "preflight never budgeted the model under test");
  assert.equal(luna.nativeSearchEnabled, true);
  assert.deepEqual(
    luna.nativeSearch,
    openAi,
    "a quote that reserves less than the request it quotes is not a quote"
  );

  // The other panel is reserved on its own capability's ceiling, not on the
  // first one's.
  const haiku = calls.find((call) => call.modelId === ANTHROPIC_MODEL_ID);
  assert.ok(haiku);
  assert.equal(haiku.nativeSearchEnabled, true);
  assert.deepEqual(haiku.nativeSearch, anthropic);
});

test("availability reserves exactly what the chat route reserves", async () => {
  const expected = await expectedAuthorization(MODEL_ID);
  const { POST } = await availabilityRoute();
  session = { user: { id: SESSION_USER_ID, email: "parity@example.test" } };
  const calls = await budgetsFor(() =>
    POST(
      jsonRequest("/api/chat/availability", {
        modelIds: [MODEL_ID],
        prompt: "what happened today?",
        webSearchMode: "always",
      })
    )
  );
  session = null;
  const luna = calls.find((call) => call.modelId === MODEL_ID);
  assert.ok(luna, "availability never budgeted the model under test");
  assert.equal(luna.nativeSearchEnabled, true);
  assert.deepEqual(
    luna.nativeSearch,
    expected,
    "a probe that measures a smaller request than the one it is checking answers the wrong question"
  );
});

test("web search off reserves nothing extra", async () => {
  const { POST } = await preflightRoute();
  session = null;
  const calls = await budgetsFor(() =>
    POST(
      jsonRequest("/api/chat/preflight", {
        comparisonId: "1754000000001",
        conversationId: "private-chat",
        modelIds: [MODEL_ID, ANTHROPIC_MODEL_ID],
        prompt: "explain quicksort",
        attachments: [],
      })
    )
  );
  assert.ok(calls.length > 0, "preflight budgeted nothing at all");
  for (const call of calls) {
    assert.equal(call.nativeSearchEnabled, false, call.modelId);
    assert.deepEqual(call.nativeSearch, NO_SEARCH, call.modelId);
  }
});

test("a native model whose search cost has no ceiling is priced as not searching", async () => {
  // Gemini's grounding takes no per-request cap, so no tool is attached and no
  // per-query cost is reserved -- and, just as importantly, the comparison is
  // not refused: that panel answers without a search and says so, while the
  // panels beside it still search.
  const { POST } = await preflightRoute();
  session = null;
  const calls = await budgetsFor(() =>
    POST(
      jsonRequest("/api/chat/preflight", {
        comparisonId: "1754000000002",
        conversationId: "private-chat",
        modelIds: GUEST_TRIO,
        prompt: "what happened today?",
        attachments: [],
        webSearchMode: "always",
      })
    )
  );
  const gemini = calls.find((call) => call.modelId === UNBOUNDED_MODEL_ID);
  assert.ok(gemini, "preflight never budgeted the Gemini panel");
  assert.equal(gemini.nativeSearchEnabled, false);
  assert.deepEqual(gemini.nativeSearch, NO_SEARCH);

  for (const modelId of [MODEL_ID, ANTHROPIC_MODEL_ID]) {
    const call = calls.find((entry) => entry.modelId === modelId);
    assert.ok(call, modelId);
    assert.equal(call.nativeSearchEnabled, true, modelId);
    assert.deepEqual(call.nativeSearch, await expectedAuthorization(modelId));
  }
});
