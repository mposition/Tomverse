import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * What POST /api/chat actually hands settlement about a native web search.
 *
 * `chat-attempt-usage.db.test.ts` proves `settleChatUsage` prices a search
 * correctly once it has the figures. It cannot prove the route ever gives them
 * to it -- and for as long as the handler has existed it did not.
 * `settleSafely`'s `usage` parameter listed no search fields,
 * `searchSettlementFields` was spread into it, and TypeScript does not
 * excess-property-check a spread. Both figures were dropped in the one
 * function between the normalizer and the ledger, so every completed search
 * settled as zero queries while the tests that called `settleChatUsage`
 * directly went on passing. That is the same shape of defect as shipping a
 * pricing function with no caller: the arithmetic was right and nothing ran it.
 *
 * So this drives the real handler, against a real database, with a real
 * reservation and a real settlement, and reads the ledger rows afterwards.
 * Only two seams are replaced: the session, and the provider stream.
 *
 * Runs in its own process under scripts/run-db-integration-tests.mjs, because
 * mock.module is process-global.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const SEARCH_MODEL_ID = "claude-sonnet-5";
const SEARCH_PROVIDER = "anthropic";

process.env.ANTHROPIC_API_KEY ||= "db-integration-test-key";

// --- session seam ----------------------------------------------------------
let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

// --- provider stream seam --------------------------------------------------
/**
 * One `tool-result` part per billable query, which is what the provider
 * returns and what `normalizeWebSearchExecution` counts. Citations are
 * `source` parts and deliberately not these.
 */
const searchContent = (queries: number) =>
  Array.from({ length: queries }, (_, index) => ({
    type: "tool-result" as const,
    toolName: "web_search",
    toolCallId: `call-${index}`,
    output: { type: "json", value: { results: [] } },
  }));

type StreamScript = {
  text: string;
  queries: number;
  outputTokens: number;
};

let script: StreamScript = { text: "an answer", queries: 0, outputTokens: 120 };
let streamTextCalls = 0;

mock.module("ai", {
  namedExports: {
    streamText: () => {
      streamTextCalls += 1;
      const text = script.text;
      return {
        textStream: new ReadableStream<string>({
          start(controller) {
            controller.enqueue(text);
            controller.close();
          },
        }),
        response: Promise.resolve({
          id: `resp-${randomUUID()}`,
          modelId: SEARCH_MODEL_ID,
        }),
        usage: Promise.resolve({
          inputTokens: 1_000,
          outputTokens: script.outputTokens,
          cachedInputTokens: 0,
          // The AI SDK reports cache reads under a nested detail object, and
          // the route reads it unguarded.
          inputTokenDetails: { cacheReadTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
        }),
        finishReason: Promise.resolve("stop"),
        rawFinishReason: Promise.resolve("end_turn"),
        content: Promise.resolve(searchContent(script.queries)),
        providerMetadata: Promise.resolve({}),
      };
    },
  },
});

// Nothing here may reach the network.
let offHostCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  offHostCalls.push(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as Request).url)
  );
  return new Response(null, { status: 204 });
}) as typeof fetch;

type RouteModule = { POST: (request: Request) => Promise<Response> };
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let chatRoute: RouteModule;
let getNativeSearchCostMicroUsdPerQuery: (typeof import("@/lib/modelPricing"))["getNativeSearchCostMicroUsdPerQuery"];

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  chatRoute = (await import(mod("app/api/chat/route.ts"))) as RouteModule;
  ({ getNativeSearchCostMicroUsdPerQuery } = (await import(
    mod("lib/modelPricing.ts")
  )) as typeof import("@/lib/modelPricing"));
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ContextManifest",
      "RoutingAttempt",
      "RoutingRun",
      "ProviderDailyUsage",
      "TokenEstimateShadowSample",
      "ChatAttemptUsageAdjustment",
      "ChatAttemptUsage",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditLedgerEntry",
      "CreditLot",
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  offHostCalls = [];
  streamTextCalls = 0;
  script = { text: "an answer", queries: 0, outputTokens: 120 };
  sessionOverride = null;
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedProUser = async () => {
  const user = await prisma.user.create({
    data: {
      email: `chat-search-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  sessionOverride = { user: { id: user.id, email: user.email } };
  return user;
};

const seedConversation = (userId: string) =>
  prisma.conversation.create({
    data: {
      userId,
      title: "Native search settlement",
      selectedModels: JSON.stringify([SEARCH_MODEL_ID]),
    },
  });

const askWithSearch = (conversationId: string) =>
  chatRoute.POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "what happened today" }],
        modelId: SEARCH_MODEL_ID,
        conversationId,
        // Both or neither: the route refuses half a persistence target.
        assistantMessageId: randomUUID(),
        webSearchMode: "always",
      }),
    })
  );

/** Read the whole response body, which is what makes the route settle. */
const drain = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
};

const settledAttempt = async () => {
  const rows = await prisma.chatAttemptUsage.findMany();
  assert.equal(rows.length, 1, "expected exactly one attempt cost row");
  return rows[0]!;
};

/**
 * A turn with searches costs a turn without them exactly the search rate times
 * the query count. Measured as a difference so the assertion does not have to
 * restate the model's token pricing, which is not what this test is about.
 */
const settledCostOfOneTurn = async (queries: number) => {
  await reset();
  streamTextCalls = 0;
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  script = { text: "an answer", queries, outputTokens: 120 };
  const response = await askWithSearch(conversation.id);
  if (response.status !== 200) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  await drain(response);
  assert.equal(streamTextCalls, 1);
  const row = await settledAttempt();
  return Number(row.costMicroUsd);
};

test("a completed native search reaches the ledger with the queries the provider ran", async () => {
  const withoutSearch = await settledCostOfOneTurn(0);
  const withTwoQueries = await settledCostOfOneTurn(2);

  const rate = getNativeSearchCostMicroUsdPerQuery(SEARCH_PROVIDER);
  assert.ok(rate && rate > 0, "anthropic has no per-query search rate to test");
  // Before the route was wired, this difference was 0: the normalizer counted
  // two queries, `settleSafely` dropped both figures, and the ledger recorded
  // the tokens alone.
  assert.equal(withTwoQueries - withoutSearch, rate * 2);

  // And the same amount reached the provider's own spend rollup, which is the
  // budget that is supposed to bound it.
  const rollup = await prisma.providerDailyUsage.findFirstOrThrow({
    where: { provider: SEARCH_PROVIDER, source: "internal" },
  });
  assert.equal(rollup.estimatedCostMicroUsd, withTwoQueries);
  assert.deepEqual(offHostCalls, [], "the route reached an unexpected host");
});

test("a completed search is recorded as measured, not as an upper bound", async () => {
  await settledCostOfOneTurn(2);
  const row = await settledAttempt();
  // The reserved-ceiling path is for turns nobody observed. This one was
  // observed, so its provenance must not claim otherwise.
  assert.notEqual(row.costSource, "reserved_upper_bound");
  assert.notEqual(row.usageSource, "crash_reconciliation");
});
