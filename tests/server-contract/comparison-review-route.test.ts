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
  /** Holds a run's claim release open, to land a request between save and release. */
  releaseGate: Gate | null;
  stored: Map<string, { id: string; assistantMessageIds: string[]; reviewerModelId: string; promptVersion: string; result: unknown; usageCredits: number; isStale: boolean; createdAt: Date; updatedAt: Date }>;
  latestTurn: { prompt: typeof PROMPT; responses: typeof TWO_ANSWERS } | null;
  latestTurnReads: number;
  rateLimits: Array<{ scope: string; limits: { minute: number; day: number } }>;
  /** A rate-limit scope whose bucket is spent. */
  refusedScope: string | null;
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
  releaseGate: null,
  stored: new Map(),
  latestTurn: { prompt: PROMPT, responses: TWO_ANSWERS },
  latestTurnReads: 0,
  rateLimits: [],
  refusedScope: null,
});

let world = freshWorld();
let writes = 0;
/**
 * What the chat route does when another answer to the question is saved: it
 * marks the question's *fresh* reviews stale (`isStale: false` in its where).
 * Whether that `updateMany` also moves `@updatedAt` is exercised both ways,
 * since the waiting rules must hold either way.
 */
const markStale = ({ bumpUpdatedAt = true } = {}) => {
  for (const row of world.stored.values()) {
    if (row.isStale) continue;
    row.isStale = true;
    if (bumpUpdatedAt) row.updatedAt = new Date(Date.UTC(2026, 10, 27) + ++writes * 1000);
  }
};
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

  const realApiSecurity = original("lib/apiSecurity.ts") as Record<string, unknown> & {
    ApiSecurityError: new (status: number, code: string, message: string, retryAfter?: number) => Error;
  };
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ...realApiSecurity,
      consumeApiRateLimit: async (_request: unknown, _user: string, scope: string, limits: { minute: number; day: number }) => {
        world.rateLimits.push({ scope, limits });
        if (scope === world.refusedScope) {
          throw new realApiSecurity.ApiSecurityError(429, "API_RATE_LIMITED", "Too many requests.", 3600);
        }
      },
    },
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
      latestComparableConversationTurn: async () => {
        world.latestTurnReads += 1;
        return world.latestTurn;
      },
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
          // Distinct per run, so a test can tell which run wrote a row.
          usageCredits: 7 + world.runs,
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
          world.events.push("claim:refused");
          throw new realChatSecurity.ChatAccessError(409, "DUPLICATE_REQUEST", "This request is already being processed.");
        }
        const token = nextToken++;
        world.claims.set(key, token);
        world.events.push("claim");
        return { key, period: `${scope}-in-flight`, periodStart: new Date(0), token };
      },
      releaseInFlightRun: async (claim: { key: string; token: number }) => {
        if (world.releaseGate) await world.releaseGate.promise;
        world.releases += 1;
        world.events.push("claim:release");
        if (world.claims.get(claim.key) === claim.token) world.claims.delete(claim.key);
      },
      isInFlightRunLive: async (subjectKey: string, scope: string, runKey: string) => {
        world.events.push("live:read");
        return world.claims.has(`${subjectKey}:${scope}:${runKey}`);
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
          findUnique: async ({ where, select }: { where: { userId_inputHash: { inputHash: string } }; select?: unknown }) => {
            world.events.push(select ? "fingerprint:read" : "cache:read");
            const row = world.stored.get(where.userId_inputHash.inputHash);
            return row ? { ...row } : null;
          },
          upsert: async ({ where, create }: { where: { userId_inputHash: { inputHash: string } }; create: { assistantMessageIds: string[]; reviewerModelId: string; promptVersion: string; result: unknown; usageCredits: number } }) => {
            world.events.push("upsert");
            if (world.upsertThrows) throw new Error("database went away");
            const existing = world.stored.get(where.userId_inputHash.inputHash);
            // Like @updatedAt: every write moves the timestamp forward.
            const row = {
              id: existing?.id ?? `review-${world.stored.size + 1}`,
              ...create,
              isStale: false,
              createdAt: existing?.createdAt ?? new Date(0),
              updatedAt: new Date(Date.UTC(2026, 10, 27) + ++writes * 1000),
            };
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

  // Nothing is read before the claim: the fingerprint is taken only after a
  // refusal (see "the reviewer's race").
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

  const exact = await json(await GET(get(exactQuery([ANSWER_A, ANSWER_B])), context));
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

function exactQuery(ids: string[], promptMessageId = PROMPT_ID, savedBefore = "none") {
  return {
    reviewMode: "balanced",
    includeSynthesis: "false",
    promptMessageId,
    assistantMessageIds: ids.join(","),
    savedBefore,
  };
}

test("an exact turn that no longer exists is its own answer, never the latest turn's review", async () => {
  const { GET, POST } = await loadRoute();
  // The latest turn has a saved review a careless fallback would hand out.
  assert.equal((await POST(post(), context)).status, 200);
  const latest = await json(await GET(get({ reviewMode: "balanced", includeSynthesis: "false" }), context));
  assert.ok(latest.storedReview, "fixture: the latest turn should have a saved review");

  // The run being waited on reviewed answers that were since deleted or
  // regenerated, or a question that is gone.
  for (const query of [
    exactQuery([ANSWER_A, "51111111-1111-4111-8111-111111111111"]),
    exactQuery([ANSWER_A, ANSWER_B], "99999999-9999-4999-8999-999999999999"),
  ]) {
    const gone = await GET(get(query), context);
    const body = await json(gone);
    assert.equal(gone.status, 404);
    assert.equal(body.code, "COMPARISON_REVIEW_TURN_NOT_FOUND");
    assert.equal(body.storedReview, undefined, "another turn's review was handed to a waiting client");
  }
});

test("an exact turn without a saved row yet says so instead of describing the latest turn", async () => {
  const { GET } = await loadRoute();
  const waiting = await GET(get(exactQuery([ANSWER_A, ANSWER_B])), context);
  const body = await json(waiting);
  assert.equal(waiting.status, 200);
  assert.equal(body.storedReview, null);
  assert.equal(body.assistantMessageIds, undefined, "a lookup must not return a runnable setup");
  assert.equal(world.runs, 0);
});

test("an incomplete exact lookup is refused rather than answered for the latest turn", async () => {
  const { GET } = await loadRoute();
  const incomplete: Array<Record<string, string>> = [
    { reviewMode: "balanced", promptMessageId: PROMPT_ID },
    { reviewMode: "balanced", assistantMessageIds: [ANSWER_A, ANSWER_B].join(",") },
    { promptMessageId: PROMPT_ID, assistantMessageIds: [ANSWER_A, ANSWER_B].join(","), savedBefore: "none" },
    // Without the pre-run fingerprint a lookup could not tell the joined
    // run's result from an older row of the same input.
    { reviewMode: "balanced", promptMessageId: PROMPT_ID, assistantMessageIds: [ANSWER_A, ANSWER_B].join(",") },
    { ...exactQuery([ANSWER_A, ANSWER_B]), savedBefore: "yesterday" },
  ];
  for (const query of incomplete) {
    const refused = await GET(get(query), context);
    assert.equal(refused.status, 400);
    assert.equal((await json(refused)).code, "INVALID_COMPARISON_REVIEW_LOOKUP");
  }
  assert.equal(world.latestTurnReads, 0);
  assert.deepEqual(world.rateLimits, [], "a malformed lookup spent rate limit before it was refused");
});

test("an exact lookup does not depend on the latest turn being comparable or small enough", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  const query = exactQuery([ANSWER_A, ANSWER_B]);

  // A newer question whose answers are still generating.
  world.latestTurn = null;
  world.latestTurnReads = 0;
  const pendingLatest = await json(await GET(get(query), context));
  assert.ok(pendingLatest.storedReview, "a newer, unfinished question hid the waited-on result");

  // A newer question over the review size limit.
  world.latestTurn = {
    prompt: { ...PROMPT, id: "61111111-1111-4111-8111-111111111111", content: "x".repeat(200_000) },
    responses: TWO_ANSWERS,
  };
  const oversizedLatest = await GET(get(query), context);
  assert.equal(oversizedLatest.status, 200);
  assert.ok((await json(oversizedLatest)).storedReview, "an oversized newer question hid the waited-on result");
  assert.equal(world.latestTurnReads, 0, "the exact lookup read the latest turn");
});

test("an exact lookup still finds its row after a later answer marked it stale", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  // The chat route marks every review of a question stale when another answer
  // to it is saved -- e.g. the third model finishing just after this run.
  markStale();

  const latest = await json(await GET(get({ reviewMode: "balanced", includeSynthesis: "false" }), context));
  assert.equal(latest.storedReview, undefined, "the setup lookup keeps refusing stale rows");
  const exact = await json(await GET(get(exactQuery([ANSWER_A, ANSWER_B])), context));
  assert.ok(exact.storedReview, "the waited-on result was hidden by the stale flag");
  assert.equal(world.runs, 1);
});

test("exact lookups spend their own rate-limit bucket, never the setup preview's", async () => {
  const { GET } = await loadRoute();
  const realInFlight = require(resolve(ROOT, "lib/comparisonReviewInFlight.ts")) as {
    COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE: string;
    COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT: { minute: number; day: number };
  };
  await GET(get(exactQuery([ANSWER_A, ANSWER_B])), context);
  await GET(get({ reviewMode: "balanced", includeSynthesis: "false" }), context);
  assert.deepEqual(world.rateLimits, [
    {
      scope: realInFlight.COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE,
      limits: { ...realInFlight.COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT },
    },
    { scope: "comparison-review-preview", limits: { minute: 20, day: 300 } },
  ]);

  // A spent lookup bucket answers 429 with Retry-After and leaves the setup
  // preview working.
  world.refusedScope = realInFlight.COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE;
  const limited = await GET(get(exactQuery([ANSWER_A, ANSWER_B])), context);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "3600");
  await limited.text();
  const setup = await GET(get({ reviewMode: "balanced", includeSynthesis: "false" }), context);
  assert.equal(setup.status, 200);
  await setup.text();
});

// --- which row a waiting client may receive ---------------------------------

type StoredDto = { originalUsageCredits: number } | null;
const joinWhileRunning = async (POST: NonNullable<typeof route>["POST"]) => {
  world.runGate = gate();
  const owner = POST(post(), context);
  await until(() => world.runs >= 1 && world.events.at(-1) === "run");
  const duplicate = await POST(post(), context);
  const body = await json(duplicate);
  assert.equal(duplicate.status, 409);
  assert.equal(body.code, "DUPLICATE_REQUEST");
  return { owner, savedBefore: body.savedBefore as string | null };
};
const lookUp = async (GET: NonNullable<typeof route>["GET"], savedBefore: string | null) =>
  json(await GET(get(exactQuery([ANSWER_A, ANSWER_B], PROMPT_ID, savedBefore ?? "none")), context));

test("a wait on a re-run of a stale row gets the new result, never the old one", async () => {
  const { GET, POST } = await loadRoute();
  // An earlier run of the same input, since marked stale: it is why the
  // next POST runs again (and is charged again) instead of being cached.
  assert.equal((await POST(post(), context)).status, 200);
  markStale();
  const previous = [...world.stored.values()][0];

  const { owner, savedBefore } = await joinWhileRunning(POST);
  assert.equal(savedBefore, previous.updatedAt.toISOString(), "the 409 must name the stale row it supersedes");
  const during = await lookUp(GET, savedBefore);
  assert.equal(during.storedReview, null, "the waiting client was handed the previous run's result");
  assert.equal(during.running, true);

  world.runGate!.open();
  assert.equal((await owner).status, 200);
  const after = await lookUp(GET, savedBefore);
  assert.equal((after.storedReview as StoredDto)?.originalUsageCredits, 9, "the wait must end on the joined run's own row");
  assert.equal(world.runs, 2);
});

test("a result marked stale right after it saved is still the waiting client's", async () => {
  const { GET, POST } = await loadRoute();
  const { owner, savedBefore } = await joinWhileRunning(POST);
  assert.equal(savedBefore, null, "no row existed before the joined run");
  world.runGate!.open();
  assert.equal((await owner).status, 200);
  // The third model finishes just after the 2-answer run saved.
  markStale();
  const after = await lookUp(GET, savedBefore);
  assert.equal((after.storedReview as StoredDto)?.originalUsageCredits, 8);
});

test("a joined run that ends without saving ends the wait instead of returning an older row", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  markStale();
  world.runBehaviour = "fail";
  const { owner, savedBefore } = await joinWhileRunning(POST);
  assert.equal((await lookUp(GET, savedBefore)).running, true);

  world.runGate!.open();
  assert.equal((await owner).status, 502);
  const after = await lookUp(GET, savedBefore);
  assert.equal(after.storedReview, null, "the stale row of an earlier run was handed out as this run's result");
  assert.equal(after.running, false, "a run that ended without a row must end the wait");
});

test("a joined run that ends without saving and with no earlier row ends the wait", async () => {
  const { GET, POST } = await loadRoute();
  world.runBehaviour = "fail";
  const { owner, savedBefore } = await joinWhileRunning(POST);
  world.runGate!.open();
  assert.equal((await owner).status, 502);
  const after = await lookUp(GET, savedBefore);
  assert.equal(after.storedReview, null);
  assert.equal(after.running, false);
});

for (const bumpUpdatedAt of [true, false]) {
  const marking = bumpUpdatedAt ? "stale-marking moves updatedAt" : "stale-marking keeps updatedAt";

  test(`the reviewer's race: the fingerprint is read after the refusal, never before (${marking})`, async () => {
    const { GET, POST } = await loadRoute();
    // A valid row, which then turns stale; another request claims and runs.
    assert.equal((await POST(post(), context)).status, 200);
    markStale({ bumpUpdatedAt });
    const staleRow = [...world.stored.values()][0];
    world.runGate = gate();
    const runner = POST(post(), context);
    await until(() => world.runs === 2);

    world.events = [];
    const duplicate = await POST(post(), context);
    const body = await json(duplicate);
    assert.equal(duplicate.status, 409);
    // No read before the claim attempt: the row is read only once the claim
    // was refused, so it cannot be a fresh row that went stale in between.
    assert.deepEqual(world.events, ["claim:refused", "fingerprint:read"]);
    assert.equal(body.savedBefore, staleRow.updatedAt.toISOString());

    // A third answer finishing mid-run touches fresh rows only.
    markStale({ bumpUpdatedAt });
    const during = await lookUp(GET, body.savedBefore as string);
    assert.equal(during.storedReview, null, "the stale row from before the join was handed out as the new result");
    assert.equal(during.running, true);

    world.runGate.open();
    assert.equal((await runner).status, 200);
    const after = await lookUp(GET, body.savedBefore as string);
    assert.equal((after.storedReview as StoredDto)?.originalUsageCredits, 9, "the wait must end on the new run's row");
  });

  test(`saved but not yet released: pending while live, then the fresh row (${marking})`, async () => {
    const { GET, POST } = await loadRoute();
    world.releaseGate = gate();
    const runner = POST(post(), context);
    await until(() => world.events.includes("upsert"));
    const duplicate = await POST(post(), context);
    const body = await json(duplicate);
    assert.equal(duplicate.status, 409);
    const row = [...world.stored.values()][0];
    // The row as it is after the refusal, fresh or not.
    assert.equal(body.savedBefore, row.updatedAt.toISOString());
    const during = await lookUp(GET, body.savedBefore as string);
    assert.equal(during.storedReview, null);
    assert.equal(during.running, true);

    world.releaseGate.open();
    assert.equal((await runner).status, 200);
    const after = await lookUp(GET, body.savedBefore as string);
    assert.equal((after.storedReview as StoredDto)?.originalUsageCredits, 8, "an unchanged fresh row with no live claim is this input's result");
  });

  test(`saved, marked stale, then a duplicate before the release: ends, never a wrong row (${marking})`, async () => {
    const { GET, POST } = await loadRoute();
    world.releaseGate = gate();
    const runner = POST(post(), context);
    await until(() => world.events.includes("upsert"));
    markStale({ bumpUpdatedAt });
    const duplicate = await POST(post(), context);
    const body = await json(duplicate);
    assert.equal(duplicate.status, 409);
    assert.equal((await lookUp(GET, body.savedBefore as string)).running, true);

    world.releaseGate.open();
    assert.equal((await runner).status, 200);
    const after = await lookUp(GET, body.savedBefore as string);
    // The accepted narrow case: the result exists but reads as "ended"
    // (missed, never wrong).
    assert.equal(after.storedReview, null);
    assert.equal(after.running, false);
  });
}

test("decision table: an unchanged fresh row with no live claim is saved (cache-hit join)", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  const row = [...world.stored.values()][0];
  const after = await lookUp(GET, row.updatedAt.toISOString());
  assert.equal((after.storedReview as StoredDto)?.originalUsageCredits, 8);
});

test("decision table: an unchanged stale row with no live claim is ended", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  markStale();
  const row = [...world.stored.values()][0];
  const after = await lookUp(GET, row.updatedAt.toISOString());
  assert.equal(after.storedReview, null);
  assert.equal(after.running, false);
});

test("decision table: no row is pending while live and ended once not", async () => {
  const { GET, POST } = await loadRoute();
  world.runGate = gate();
  const runner = POST(post(), context);
  await until(() => world.runs === 1);
  assert.deepEqual(
    [(await lookUp(GET, null)).storedReview, (await lookUp(GET, null)).running],
    [null, true]
  );
  world.runBehaviour = "fail";
  world.runGate.open();
  assert.equal((await runner).status, 502);
  const after = await lookUp(GET, null);
  assert.deepEqual([after.storedReview, after.running], [null, false]);
});

test("liveness is read before the row, so a run that saved and released is never reported ended", async () => {
  const { GET } = await loadRoute();
  world.events = [];
  await lookUp(GET, null);
  const live = world.events.indexOf("live:read");
  const row = world.events.indexOf("cache:read");
  assert.ok(live >= 0 && row > live, `lookup order was ${world.events.join(", ")}`);
});
