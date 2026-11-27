import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for POST /api/conversations/:id/comparison-reviews --
 * the signed-in AI Review -- and the one property its guest counterpart
 * already had: a second request for the same input while the first is still
 * running must not run, bill or reserve anything.
 *
 * The persisted row is written only after the reviewers finish (tens of
 * seconds, minutes at worst), so the cache alone could not see a run in
 * flight. This harness drives the real handler with the paid pipeline, the
 * Free quota and the in-flight claim replaced by faithful in-memory stand-ins
 * (the claim's SQL is pinned in comparison-review-run-claim.test.ts), and
 * asserts ordering and release on every exit path.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "comparison-review-route-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const USER_ID = "user-contract-1";
const CONVERSATION_ID = "conversation-1";
const PROMPT_ID = "11111111-1111-4111-8111-111111111111";
const ANSWER_A = "21111111-1111-4111-8111-111111111111";
const ANSWER_B = "31111111-1111-4111-8111-111111111111";
const ANSWER_C = "41111111-1111-4111-8111-111111111111";

const RESULT = {
  consensus: [],
  differences: [],
  contradictions: [],
  missingPoints: [],
  verificationNeeded: [],
  modelAssessments: [],
  synthesis: "",
  confidence: "medium",
  limitations: [],
  groundingStats: { totalCitations: 0, verifiedCitations: 0 },
};
const REVIEW_RESULT = {
  primary: { reviewerModelId: "mistral-medium-3-1", result: RESULT },
  secondary: null,
  agreement: null,
};

const response = (messageId: string, modelId: string, provider: string) => ({
  messageId,
  modelId,
  modelName: modelId,
  provider,
  content: `Answer from ${modelId}.`,
});
const TWO_ANSWERS = [response(ANSWER_A, "gpt-5-4-mini", "openai"), response(ANSWER_B, "claude-haiku-4-5", "anthropic")];
const THREE_ANSWERS = [...TWO_ANSWERS, response(ANSWER_C, "gemini-2-5-flash", "google")];
const PROMPT = { id: PROMPT_ID, role: "user", content: "Which approach?", modelId: null, conversationId: CONVERSATION_ID, createdAt: new Date(0) };

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
};

type World = {
  events: string[];
  runs: number;
  runGate: Gate | null;
  runBehaviour: "succeed" | "fail" | "throw";
  upsertThrows: boolean;
  tier: "Free" | "Pro";
  quotaHeld: number;
  /** key -> token, the in-memory stand-in for the claim row. */
  claims: Map<string, number>;
  claimCalls: Array<{ subjectKey: string; scope: string; runKey: string; ttlSeconds: number }>;
  releases: number;
  stored: Map<string, { id: string; assistantMessageIds: string[]; reviewerModelId: string; promptVersion: string; result: unknown; usageCredits: number; isStale: boolean; createdAt: Date }>;
  latestTurn: { prompt: typeof PROMPT; responses: typeof TWO_ANSWERS };
};

const freshWorld = (): World => ({
  events: [],
  runs: 0,
  runGate: null,
  runBehaviour: "succeed",
  upsertThrows: false,
  tier: "Free",
  quotaHeld: 0,
  claims: new Map(),
  claimCalls: [],
  releases: 0,
  stored: new Map(),
  latestTurn: { prompt: PROMPT, responses: TWO_ANSWERS },
});

let world = freshWorld();
let route: {
  GET: (request: Request, context: { params: Promise<{ conversationId: string }> }) => Promise<Response>;
  POST: (request: Request, context: { params: Promise<{ conversationId: string }> }) => Promise<Response>;
} | null = null;

async function loadRoute() {
  if (route) return route;
  const original = (path: string) => require(resolve(ROOT, path)) as Record<string, unknown>;
  const realChatSecurity = original("lib/chatSecurity.ts") as Record<string, unknown> & {
    ChatAccessError: new (status: number, code: string, message: string) => Error;
  };

  mock.module(mod("lib/chatRouteSession.ts"), {
    namedExports: {
      resolveChatRouteSession: async () => ({ session: { user: { id: USER_ID }, expires: "2099-01-01T00:00:00.000Z" } }),
    },
  });

  const realApiSecurity = original("lib/apiSecurity.ts");
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
  });

  const realLock = original("lib/conversationLock.ts");
  mock.module(mod("lib/conversationLock.ts"), {
    namedExports: { ...realLock, hasConversationUnlockGrant: () => true },
  });

  mock.module(mod("lib/billingEntitlements.ts"), {
    namedExports: {
      ...original("lib/billingEntitlements.ts"),
      getUserBillingPlan: async () => ({ tier: world.tier, dailyMessageLimit: 100, monthlyMessageLimit: 1000 }),
    },
  });

  mock.module(mod("lib/comparisonReviewTurn.ts"), {
    namedExports: {
      latestComparableConversationTurn: async () => world.latestTurn,
      requestedComparableConversationTurn: async (_conversationId: string, promptMessageId: string, ids: string[]) => {
        if (promptMessageId !== PROMPT_ID) return null;
        const byId = new Map(THREE_ANSWERS.map((answer) => [answer.messageId, answer]));
        const responses = ids.map((id) => byId.get(id));
        return responses.every(Boolean) ? { prompt: PROMPT, responses } : null;
      },
    },
  });

  // --- the paid seam --------------------------------------------------------
  const realService = original("lib/comparisonReviewService.ts");
  mock.module(mod("lib/comparisonReviewService.ts"), {
    namedExports: {
      ...realService,
      estimateComparisonReview: async () => ({ candidates: [], estimatedCredits: 8, dualReview: false, reviewerClass: "Advanced" }),
      runComparisonReview: async (_subject: unknown, input: { responses: Array<{ messageId: string; modelId: string; modelName: string }> }) => {
        world.runs += 1;
        world.events.push("run");
        if (world.runGate) await world.runGate.promise;
        if (world.runBehaviour === "fail") {
          throw new (realService.ComparisonReviewFailedError as new () => Error)();
        }
        if (world.runBehaviour === "throw") throw new Error("provider exploded");
        return {
          result: REVIEW_RESULT,
          responseMap: input.responses.map((answer, index) => ({
            responseId: ["A", "B", "C"][index],
            messageId: answer.messageId,
            modelId: answer.modelId,
            modelName: answer.modelName,
          })),
          reviewerModelId: "mistral-medium-3-1",
          usageCredits: 8,
        };
      },
    },
  });

  mock.module(mod("lib/comparisonReviewRunTelemetry.ts"), {
    namedExports: { recordComparisonReviewRun: async () => {} },
  });

  // --- the Free plan's monthly quota ----------------------------------------
  const realQuota = original("lib/comparisonReviewQuota.ts");
  mock.module(mod("lib/comparisonReviewQuota.ts"), {
    namedExports: {
      ...realQuota,
      reserveFreeComparisonReview: async (subjectKey: string) => {
        world.quotaHeld += 1;
        world.events.push("quota");
        return { key: `${subjectKey}:comparison-review`, period: "comparison-review-month", periodStart: new Date(0) };
      },
      releaseComparisonReviewQuota: async () => {
        world.quotaHeld -= 1;
        world.events.push("quota:release");
      },
    },
  });

  // --- the in-flight claim --------------------------------------------------
  const realClaims = original("lib/guestIdempotency.ts");
  let nextToken = 1;
  mock.module(mod("lib/guestIdempotency.ts"), {
    namedExports: {
      ...realClaims,
      claimInFlightRun: async (subjectKey: string, scope: string, runKey: string, ttlSeconds: number) => {
        world.claimCalls.push({ subjectKey, scope, runKey, ttlSeconds });
        const key = `${subjectKey}:${scope}:${runKey}`;
        if (world.claims.has(key)) {
          throw new realChatSecurity.ChatAccessError(409, "DUPLICATE_REQUEST", "This request is already being processed.");
        }
        const token = nextToken++;
        world.claims.set(key, token);
        world.events.push("claim");
        return { key, period: `${scope}-in-flight`, periodStart: new Date(0), token };
      },
      releaseInFlightRun: async (claim: { key: string; token: number }) => {
        world.releases += 1;
        world.events.push("claim:release");
        if (world.claims.get(claim.key) === claim.token) world.claims.delete(claim.key);
      },
    },
  });

  // --- the rows the route reads and writes ----------------------------------
  mock.module(mod("lib/prisma.ts"), {
    namedExports: {
      prisma: {
        conversation: {
          findUnique: async () => ({
            id: CONVERSATION_ID, userId: USER_ID, password: null, passwordVersion: 0,
            title: "Contract", kind: "chat", productKey: "chat",
          }),
        },
        userSettings: { findUnique: async () => ({ language: "en" }) },
        comparisonReview: {
          findUnique: async ({ where }: { where: { userId_inputHash: { inputHash: string } } }) => {
            world.events.push("cache:read");
            return world.stored.get(where.userId_inputHash.inputHash) ?? null;
          },
          upsert: async ({ where, create }: { where: { userId_inputHash: { inputHash: string } }; create: { assistantMessageIds: string[]; reviewerModelId: string; promptVersion: string; result: unknown; usageCredits: number } }) => {
            world.events.push("upsert");
            if (world.upsertThrows) throw new Error("database went away");
            const row = { id: `review-${world.stored.size + 1}`, ...create, isStale: false, createdAt: new Date(0) };
            world.stored.set(where.userId_inputHash.inputHash, row);
            return row;
          },
        },
      },
    },
  });

  route = (await import(`${mod("app/api/conversations/[conversationId]/comparison-reviews/route.ts")}?contract=account`)) as NonNullable<typeof route>;
  return route;
}

const context = { params: Promise.resolve({ conversationId: CONVERSATION_ID }) };
const post = (body: Record<string, unknown> = {}) =>
  new Request(`http://127.0.0.1:3100/api/conversations/${CONVERSATION_ID}/comparison-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      promptMessageId: PROMPT_ID,
      assistantMessageIds: [ANSWER_A, ANSWER_B],
      reviewMode: "balanced",
      includeSynthesis: false,
      ...body,
    }),
  });
const get = (query: Record<string, string>) =>
  new Request(`http://127.0.0.1:3100/api/conversations/${CONVERSATION_ID}/comparison-reviews?${new URLSearchParams(query)}`);
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
/** Lets the first request reach the paid seam before the second is sent. */
const until = async (condition: () => boolean) => {
  for (let tick = 0; tick < 200 && !condition(); tick += 1) await new Promise((done) => setTimeout(done, 1));
  assert.ok(condition(), "the first request never reached the review pipeline");
};

test.beforeEach(() => {
  world = freshWorld();
});

test("a second request while the same review runs is refused before any spend", async () => {
  const { POST } = await loadRoute();
  world.runGate = gate();
  const first = POST(post(), context);
  await until(() => world.runs === 1);

  // A duplicate that got through would park on the same run gate, so it is
  // raced against a short timer rather than awaited into a hang.
  const second = await Promise.race([
    POST(post(), context),
    new Promise<null>((done) => setTimeout(() => done(null), 2_000)),
  ]);
  if (!second) {
    world.runGate.open();
    assert.fail(`the duplicate reached the review pipeline (runs: ${world.runs})`);
  }
  const body = await json(second);
  assert.equal(second.status, 409);
  assert.equal(body.code, "DUPLICATE_REQUEST");
  assert.equal(world.runs, 1, "the duplicate ran and billed the review again");
  assert.equal(world.quotaHeld, 1, "the duplicate reserved a second Free slot");

  world.runGate.open();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(world.claims.size, 0, "the finished run left its claim behind");
  assert.equal(world.quotaHeld, 1, "a completed run keeps its Free slot");
});

test("the claim is per account and input, taken before the cache, the quota and the run", async () => {
  const { POST } = await loadRoute();
  const realSecurity = require(resolve(ROOT, "lib/chatSecurity.ts")) as { getUserChatUsageKey: (id: string) => string };
  const realInFlight = require(resolve(ROOT, "lib/comparisonReviewInFlight.ts")) as { COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS: number };
  const done = await POST(post(), context);
  assert.equal(done.status, 200);

  assert.deepEqual(world.events.slice(0, 4), ["claim", "cache:read", "quota", "run"]);
  assert.equal(world.events.at(-1), "claim:release");
  const [call] = world.claimCalls;
  assert.equal(call.subjectKey, realSecurity.getUserChatUsageKey(USER_ID));
  assert.equal(call.scope, "comparison-review");
  assert.match(call.runKey, /^[0-9a-f]{64}$/, "the claim is keyed on the review's input hash");
  assert.equal(call.ttlSeconds, realInFlight.COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS);
});

test("a different input is a different claim and runs alongside", async () => {
  const { POST } = await loadRoute();
  world.runGate = gate();
  const balanced = POST(post(), context);
  await until(() => world.runs === 1);
  const evidence = POST(post({ reviewMode: "evidence" }), context);
  await until(() => world.runs === 2);
  world.runGate.open();
  assert.deepEqual([(await balanced).status, (await evidence).status], [200, 200]);
  assert.equal(new Set(world.claimCalls.map((call) => call.runKey)).size, 2);
  assert.equal(world.claims.size, 0);
});

test("after a success the next request is served from the saved row, not re-run", async () => {
  const { POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  const again = await POST(post(), context);
  const body = await json(again);
  assert.equal(again.status, 200);
  assert.equal(body.cached, true);
  assert.equal(body.usageCredits, 0);
  assert.equal(world.runs, 1);
  assert.equal(world.claims.size, 0, "a cache hit left its claim behind");
  assert.equal(world.releases, 2);
});

for (const [label, setup, status] of [
  ["every reviewer failing", (w: World) => { w.runBehaviour = "fail"; }, 502],
  ["an unexpected exception", (w: World) => { w.runBehaviour = "throw"; }, 500],
  ["the save failing after the run", (w: World) => { w.upsertThrows = true; }, 500],
] as const) {
  test(`${label} releases the claim and the Free slot, so a retry can run`, async () => {
    const { POST } = await loadRoute();
    setup(world);
    const failed = await POST(post(), context);
    assert.equal(failed.status, status);
    assert.equal(world.claims.size, 0, "a failed run kept its claim: the review could not be retried");
    assert.equal(world.quotaHeld, 0, "a failed run kept its Free slot");

    world.runBehaviour = "succeed";
    world.upsertThrows = false;
    const retry = await POST(post(), context);
    assert.equal(retry.status, 200);
    assert.equal(world.runs, 2);
  });
}

test("a run waited on is found by its exact turn even after the latest turn moved", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  // A third answer finished after the 2-answer run started.
  world.latestTurn = { prompt: PROMPT, responses: THREE_ANSWERS };

  const latest = await json(await GET(get({ reviewMode: "balanced", includeSynthesis: "false" }), context));
  assert.equal(latest.storedReview, undefined, "the latest-turn lookup should not see the 2-answer run");

  const exact = await json(await GET(get({
    reviewMode: "balanced",
    includeSynthesis: "false",
    promptMessageId: PROMPT_ID,
    assistantMessageIds: [ANSWER_A, ANSWER_B].join(","),
  }), context));
  const stored = exact.storedReview as { cached: boolean; usageCredits: number; responseMap: unknown[] } | undefined;
  assert.ok(stored, "the exact-turn lookup did not find the saved run");
  assert.equal(stored.cached, true);
  assert.equal(stored.usageCredits, 0);
  assert.equal(stored.responseMap.length, 2);
  const source = exact.source as { responses: unknown[] };
  assert.equal(source.responses.length, 2, "the source must describe the reviewed turn");
  assert.equal(world.runs, 1, "a lookup never runs anything");
  assert.equal(world.claimCalls.length, 1, "a lookup never claims anything");
});

test("an unknown exact turn falls back to the latest-turn setup", async () => {
  const { GET } = await loadRoute();
  const setup = await json(await GET(get({
    reviewMode: "balanced",
    includeSynthesis: "false",
    promptMessageId: "99999999-9999-4999-8999-999999999999",
    assistantMessageIds: [ANSWER_A, ANSWER_B].join(","),
  }), context));
  assert.equal(setup.available, true);
  assert.equal(setup.storedReview, undefined);
  assert.deepEqual(setup.assistantMessageIds, [ANSWER_A, ANSWER_B]);
  assert.equal(world.runs, 0);
});
