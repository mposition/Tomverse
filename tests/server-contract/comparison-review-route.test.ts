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
 * asserts ordering and release on every exit path. The GET is pinned to what
 * it did before the claim existed: the latest turn and the chosen criteria.
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
  /**
   * key -> holder token and last renewal, the in-memory stand-in for the
   * claim row: a claim older than its TTL by `clockMs` may be taken over,
   * exactly as the SQL's takeover condition.
   */
  claims: Map<string, { token: number; renewedAt: number }>;
  clockMs: number;
  claimCalls: Array<{ subjectKey: string; scope: string; runKey: string; ttlSeconds: number }>;
  releases: number;
  renewals: number;
  stored: Map<string, { id: string; assistantMessageIds: string[]; reviewerModelId: string; promptVersion: string; result: unknown; usageCredits: number; isStale: boolean; createdAt: Date }>;
  latestTurn: { prompt: typeof PROMPT; responses: typeof TWO_ANSWERS };
  exactTurnReads: number;
  rateLimits: Array<{ scope: string; limits: { minute: number; day: number } }>;
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
  clockMs: 0,
  claimCalls: [],
  releases: 0,
  renewals: 0,
  stored: new Map(),
  latestTurn: { prompt: PROMPT, responses: TWO_ANSWERS },
  exactTurnReads: 0,
  rateLimits: [],
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
    namedExports: {
      ...realApiSecurity,
      consumeApiRateLimit: async (_request: unknown, _user: string, scope: string, limits: { minute: number; day: number }) => {
        world.rateLimits.push({ scope, limits });
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
      latestComparableConversationTurn: async () => world.latestTurn,
      requestedComparableConversationTurn: async (_conversationId: string, promptMessageId: string, ids: string[]) => {
        world.exactTurnReads += 1;
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
        const held = world.claims.get(key);
        if (held && world.clockMs - held.renewedAt < ttlSeconds * 1000) {
          world.events.push("claim:refused");
          throw new realChatSecurity.ChatAccessError(409, "DUPLICATE_REQUEST", "This request is already being processed.");
        }
        const token = nextToken++;
        world.claims.set(key, { token, renewedAt: world.clockMs });
        world.events.push("claim");
        return { key, period: `${scope}-in-flight`, periodStart: new Date(0), token };
      },
      renewInFlightRun: async (claim: { key: string; token: number }) => {
        world.renewals += 1;
        const held = world.claims.get(claim.key);
        if (held?.token !== claim.token) return false;
        held.renewedAt = world.clockMs;
        return true;
      },
      releaseInFlightRun: async (claim: { key: string; token: number }) => {
        world.releases += 1;
        world.events.push("claim:release");
        if (world.claims.get(claim.key)?.token === claim.token) world.claims.delete(claim.key);
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
  world.events = [];
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
  // Refused, then one read for a fresh saved row (there is none yet): no
  // quota, no run.
  assert.deepEqual(world.events, ["claim:refused", "cache:read"], "the duplicate reserved or ran something");
  assert.equal(world.runs, 1, "the duplicate ran and billed the review again");
  assert.equal(world.quotaHeld, 1, "the duplicate reserved a second Free slot");

  world.runGate.open();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(world.claims.size, 0, "the finished run left its claim behind");
  assert.equal(world.quotaHeld, 1, "a completed run keeps its Free slot");

  // Pressed again once the run has saved: the cache answers, nothing runs.
  const again = await POST(post(), context);
  const cached = await json(again);
  assert.equal(again.status, 200);
  assert.equal(cached.cached, true);
  assert.equal(world.runs, 1);
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

// --- a run longer than the TTL ------------------------------------------------

const realInFlightTiming = () =>
  require(resolve(ROOT, "lib/comparisonReviewInFlight.ts")) as {
    COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS: number;
    COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS: number;
  };
/** Moves the claim clock and the route's heartbeat timer together. */
const elapse = async (ms: number) => {
  world.clockMs += ms;
  mock.timers.tick(ms);
  await new Promise((done) => setImmediate(done));
};

test("a run longer than the TTL keeps its claim, and the heartbeat stops with it", async () => {
  const { POST } = await loadRoute();
  const { COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS: ttl, COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS: beat } = realInFlightTiming();
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    world.runGate = gate();
    const first = POST(post(), context);
    await until(() => world.runs === 1);
    // Twice the TTL, as a larger reviewer panel with failing candidates can take.
    while (world.clockMs < ttl * 2000) await elapse(beat);
    assert.ok(world.renewals >= 5, `the claim was renewed ${world.renewals} times`);

    const second = await Promise.race([
      POST(post(), context),
      new Promise<null>((done) => setTimeout(() => done(null), 2_000)),
    ]);
    if (!second) {
      world.runGate.open();
      assert.fail("the claim expired under a live run, and a duplicate started a second paid run");
    }
    assert.equal(second.status, 409);
    assert.equal(world.runs, 1);

    world.runGate.open();
    assert.equal((await first).status, 200);
    assert.equal(world.claims.size, 0, "the claim was not released");
    const renewalsAtEnd = world.renewals;
    await elapse(beat * 3);
    assert.equal(world.renewals, renewalsAtEnd, "the heartbeat outlived its run");
  } finally {
    mock.timers.reset();
  }
});

test("a claim lost to another holder is only logged: the run finishes and the other claim stays", async () => {
  const { POST } = await loadRoute();
  const { COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS: beat } = realInFlightTiming();
  const warn = mock.method(console, "warn", () => {});
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    world.runGate = gate();
    const first = POST(post(), context);
    await until(() => world.runs === 1);
    // Another request took the claim over (its own token).
    holdClaimFor(world.claimCalls[0], 777);
    await elapse(beat);
    assert.ok(
      warn.mock.calls.some((call) => String(call.arguments[0]).includes("comparison_review_claim_lost")),
      "a lost claim was not logged"
    );
    world.runGate.open();
    assert.equal((await first).status, 200, "a lost claim stopped a run already on its paid path");
    const [call] = world.claimCalls;
    assert.equal(world.claims.get(`${call.subjectKey}:${call.scope}:${call.runKey}`)?.token, 777, "the run released another holder's claim");
  } finally {
    mock.timers.reset();
    warn.mock.restore();
  }
});

// --- a refused request and the saved row --------------------------------------

/** Another request holds this input's claim (a cache hit or a run in progress). */
const holdClaimFor = (call: World["claimCalls"][number], token = 999) =>
  world.claims.set(`${call.subjectKey}:${call.scope}:${call.runKey}`, { token, renewedAt: world.clockMs });

for (const [label, prepare, expected] of [
  ["a fresh saved row answers from the cache", () => {}, 200],
  ["a stale saved row is still 409", (w: World) => { for (const row of w.stored.values()) row.isStale = true; }, 409],
  ["no saved row is 409", (w: World) => { w.stored.clear(); }, 409],
] as const) {
  test(`a refused request: ${label}, and nothing is reserved or run`, async () => {
    const { POST } = await loadRoute();
    assert.equal((await POST(post(), context)).status, 200);
    prepare(world);
    holdClaimFor(world.claimCalls[0]);
    world.events = [];
    const quotaBefore = world.quotaHeld;
    const refused = await POST(post(), context);
    const body = await json(refused);
    assert.equal(refused.status, expected);
    if (expected === 200) {
      assert.equal(body.cached, true);
      assert.equal(body.usageCredits, 0);
    } else {
      assert.equal(body.code, "DUPLICATE_REQUEST");
    }
    // The read comes only after the refusal; nothing else happens.
    assert.deepEqual(world.events, ["claim:refused", "cache:read"]);
    assert.equal(world.runs, 1, "a refused request ran the review");
    assert.equal(world.quotaHeld, quotaBefore, "a refused request reserved a Free slot");
  });
}

// --- the GET is what it was before the claim --------------------------------

test("the GET returns the latest turn's saved review for the chosen criteria", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  const setup = await json(await GET(get({ reviewMode: "balanced", includeSynthesis: "false" }), context));
  const stored = setup.storedReview as { cached: boolean; usageCredits: number } | undefined;
  assert.ok(stored, "the saved review of the latest turn was not returned");
  assert.equal(stored.cached, true);
  assert.equal(stored.usageCredits, 0);
  // Other criteria are another input, with no saved row.
  const evidence = await json(await GET(get({ reviewMode: "evidence", includeSynthesis: "false" }), context));
  assert.equal(evidence.storedReview, undefined);
  assert.deepEqual(evidence.assistantMessageIds, [ANSWER_A, ANSWER_B]);
  assert.deepEqual(world.rateLimits.slice(-2).map(({ scope, limits }) => [scope, limits.minute, limits.day]), [
    ["comparison-review-preview", 20, 300],
    ["comparison-review-preview", 20, 300],
  ]);
});

test("the GET ignores turn and fingerprint parameters, as it always did", async () => {
  const { GET, POST } = await loadRoute();
  assert.equal((await POST(post(), context)).status, 200);
  // A third answer finished: the latest turn is now the 3-answer turn.
  world.latestTurn = { prompt: PROMPT, responses: THREE_ANSWERS };
  const withParams = await GET(get({
    reviewMode: "balanced",
    includeSynthesis: "false",
    promptMessageId: PROMPT_ID,
    assistantMessageIds: [ANSWER_A, ANSWER_B].join(","),
    savedBefore: "none",
  }), context);
  const body = await json(withParams);
  assert.equal(withParams.status, 200);
  assert.equal(body.storedReview, undefined, "the GET looked up a turn other than the latest");
  assert.deepEqual(body.assistantMessageIds, [ANSWER_A, ANSWER_B, ANSWER_C]);
  assert.equal(body.running, undefined);
  assert.equal(world.exactTurnReads, 1, "only the POST may resolve a requested turn");
  assert.deepEqual(world.rateLimits.at(-1), { scope: "comparison-review-preview", limits: { minute: 20, day: 300 } });
});
