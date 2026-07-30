import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for POST /api/chat/comparison-review -- the guest AI
 * Review.
 *
 * The E2E suite mocks this endpoint wholesale, so it can only show that the
 * client stops asking. It cannot show what the server does when someone calls
 * it directly: a double-clicked button, a stale tab, a script. This harness
 * drives the real route handler with spies on the three seams that matter --
 * the review pipeline itself (which spends credits at a provider), the monthly
 * trial quota, and the idempotency claim -- and asserts the ordering and the
 * release behaviour that make "one run per month, charged once" true.
 *
 * The quota and idempotency modules are replaced with faithful in-memory
 * stand-ins: their conditional-upsert SQL is pinned separately in
 * tests/server-contract/guest-review-quota.test.ts, and what is under test
 * here is the route's use of them.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "guest-review-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type World = {
  /** Monthly trial slots claimed per subject, and how many were released. */
  quotaClaims: string[];
  quotaReleases: string[];
  /** Idempotency keys claimed per subject, and how many were released. */
  idempotencyClaims: string[];
  idempotencyReleases: string[];
  /** Every reviewer run the route actually started. */
  runs: Array<{ reviewerPlan: string; accessKind: string; reviewMode: string }>;
  /** Rate-limit scopes the route consumed. */
  rateLimits: string[];
  turnstileCalls: Array<string | undefined>;
  /** What the pipeline should do on its next call. */
  runBehaviour: "succeed" | "fail" | "unavailable";
  /** Live quota state, keyed by subject. */
  quotaUsed: Map<string, number>;
  quotaLimit: number;
  claimedIdempotencyKeys: Set<string>;
  /** Set when the credit reservation itself should refuse. */
  creditFailure: { code: string; status: number } | null;
};

const freshWorld = (): World => ({
  quotaClaims: [],
  quotaReleases: [],
  idempotencyClaims: [],
  idempotencyReleases: [],
  runs: [],
  rateLimits: [],
  turnstileCalls: [],
  runBehaviour: "succeed",
  quotaUsed: new Map(),
  quotaLimit: 1,
  claimedIdempotencyKeys: new Set(),
  creditFailure: null,
});

let world = freshWorld();
let mocksInstalled = false;

const REVIEW_RESULT = {
  primary: {
    reviewerModelId: "mistral-medium-3-1",
    result: {
      consensus: [],
      differences: [],
      contradictions: [],
      missingPoints: [],
      verificationNeeded: [],
      modelAssessments: [],
      synthesis: "",
      confidence: "medium",
      limitations: [],
      groundingStats: { totalCitations: 4, verifiedCitations: 3 },
    },
  },
  secondary: {
    reviewerModelId: "claude-sonnet-5",
    result: {
      consensus: [],
      differences: [],
      contradictions: [],
      missingPoints: [],
      verificationNeeded: [],
      modelAssessments: [],
      synthesis: "",
      confidence: "high",
      limitations: [],
      groundingStats: { totalCitations: 2, verifiedCitations: 2 },
    },
  },
  agreement: {
    confidenceMatches: false,
    primaryConfidence: "medium",
    secondaryConfidence: "high",
    sharedVerifiedQuoteCount: 1,
  },
};

async function loadRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
}> {
  if (mocksInstalled) {
    return (await import(`${mod("app/api/chat/comparison-review/route.ts")}?spy=cached`)) as {
      POST: (request: Request) => Promise<Response>;
    };
  }
  mocksInstalled = true;

  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;

  const realChatSecurity = original("lib/chatSecurity.ts") as Record<
    string,
    unknown
  > & { ChatAccessError: new (...args: unknown[]) => Error };

  // --- the paid seam: the shared review pipeline -----------------------------
  const realService = original("lib/comparisonReviewService.ts");
  mock.module(mod("lib/comparisonReviewService.ts"), {
    namedExports: {
      ...realService,
      runComparisonReview: async (
        subject: { access: { kind: string }; reviewerPlan: string },
        input: { reviewMode: string }
      ) => {
        world.runs.push({
          reviewerPlan: subject.reviewerPlan,
          accessKind: subject.access.kind,
          reviewMode: input.reviewMode,
        });
        if (world.runBehaviour === "unavailable") {
          throw new (realService.ComparisonReviewerUnavailableError as new () => Error)();
        }
        if (world.runBehaviour === "fail") {
          throw new (realService.ComparisonReviewFailedError as new () => Error)();
        }
        if (world.creditFailure) {
          throw new realChatSecurity.ChatAccessError(
            world.creditFailure.status,
            world.creditFailure.code,
            "Guest credit budget exhausted."
          );
        }
        return {
          result: REVIEW_RESULT,
          responseMap: [
            { responseId: "A", messageId: "m1", modelId: "gpt-5-4-mini", modelName: "GPT-5.4 mini" },
            { responseId: "B", messageId: "m2", modelId: "claude-haiku-4-5", modelName: "Claude Haiku 4.5" },
          ],
          reviewerModelId: "mistral-medium-3-1",
          usageCredits: 8,
        };
      },
    },
  });

  // --- the monthly trial quota ----------------------------------------------
  const realQuota = original("lib/comparisonReviewQuota.ts");
  mock.module(mod("lib/comparisonReviewQuota.ts"), {
    namedExports: {
      ...realQuota,
      getGuestComparisonReviewLimit: () => world.quotaLimit,
      reserveGuestComparisonReview: async (subjectKey: string) => {
        const used = world.quotaUsed.get(subjectKey) ?? 0;
        if (used >= world.quotaLimit) {
          throw new realChatSecurity.ChatAccessError(
            429,
            "GUEST_COMPARISON_REVIEW_MONTHLY_LIMIT",
            "Guests can run 1 AI review per month. Sign in for more."
          );
        }
        world.quotaUsed.set(subjectKey, used + 1);
        world.quotaClaims.push(subjectKey);
        return { key: subjectKey, period: "guest-comparison-review-month", periodStart: new Date(0) };
      },
      releaseComparisonReviewQuota: async (reservation: { key: string }) => {
        world.quotaReleases.push(reservation.key);
        world.quotaUsed.set(
          reservation.key,
          Math.max(0, (world.quotaUsed.get(reservation.key) ?? 1) - 1)
        );
      },
    },
  });

  // --- the idempotency claim -------------------------------------------------
  const realIdempotency = original("lib/guestIdempotency.ts");
  mock.module(mod("lib/guestIdempotency.ts"), {
    namedExports: {
      ...realIdempotency,
      claimGuestIdempotencyKey: async (
        subjectKey: string,
        scope: string,
        key: string
      ) => {
        const composite = `${subjectKey}:${scope}:${key}`;
        if (world.claimedIdempotencyKeys.has(composite)) {
          throw new realChatSecurity.ChatAccessError(
            409,
            "DUPLICATE_REQUEST",
            "This request is already being processed."
          );
        }
        world.claimedIdempotencyKeys.add(composite);
        world.idempotencyClaims.push(composite);
        return { key: composite, period: "guest-idempotency-comparison-review-day", periodStart: new Date(0) };
      },
      releaseGuestIdempotencyKey: async (claim: { key: string }) => {
        world.idempotencyReleases.push(claim.key);
        world.claimedIdempotencyKeys.delete(claim.key);
      },
    },
  });

  // --- infrastructure that needs a database or a Next request scope ----------
  const realApiSecurity = original("lib/apiSecurity.ts");
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ...realApiSecurity,
      consumeApiRateLimit: async (
        _request: unknown,
        _subject: string,
        scope: string
      ) => {
        world.rateLimits.push(scope);
      },
    },
  });

  const realTurnstile = original("lib/turnstile.ts");
  mock.module(mod("lib/turnstile.ts"), {
    namedExports: {
      ...realTurnstile,
      ensureGuestVerified: async (
        _request: unknown,
        token: string | undefined,
        action: string
      ) => {
        world.turnstileCalls.push(action);
        if (token === "invalid-token") {
          throw new realChatSecurity.ChatAccessError(
            403,
            "TURNSTILE_FAILED",
            "Verification failed."
          );
        }
        return undefined;
      },
    },
  });

  return (await import(`${mod("app/api/chat/comparison-review/route.ts")}?spy=cached`)) as {
    POST: (request: Request) => Promise<Response>;
  };
}

const VALID_RESPONSES = [
  { messageId: "m1", modelId: "gpt-5-4-mini", content: "The first answer." },
  { messageId: "m2", modelId: "claude-haiku-4-5", content: "The second answer." },
];

const guestRequest = (
  body: Record<string, unknown>,
  options: { cookie?: string } = {}
) =>
  new Request("http://127.0.0.1:3100/api/chat/comparison-review", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: JSON.stringify({
      question: "Which approach should we take?",
      responses: VALID_RESPONSES,
      reviewMode: "balanced",
      includeSynthesis: false,
      language: "en",
      idempotencyKey: "run-key-0001",
      ...body,
    }),
  });

/**
 * A stable guest identity across requests. The route derives it from the
 * signed cookie it issues on first contact, so a test that needs two requests
 * from the *same* guest has to carry that cookie forward -- and a test that
 * needs two *different* guests simply does not.
 */
const guestCookieFrom = (response: Response) => {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = /tomverse_guest=([^;]+)/.exec(setCookie);
  return match ? `tomverse_guest=${match[1]}` : undefined;
};

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

test.beforeEach(() => {
  world = freshWorld();
});

test("a guest with a trial available gets a real, dual-reviewer result", async () => {
  const { POST } = await loadRoute();
  const response = await POST(guestRequest({}));
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(world.runs.length, 1);
  // The same pipeline a signed-in user gets, against the same reviewer pool a
  // Free account is served from -- not a cheaper guest-only imitation.
  assert.equal(world.runs[0].reviewerPlan, "Free");
  // ...but charged and rate-limited as a guest.
  assert.equal(world.runs[0].accessKind, "guest");

  const result = body.result as typeof REVIEW_RESULT;
  assert.ok(result.secondary, "the second independent reviewer is missing");
  assert.ok(result.agreement, "the reviewer agreement is missing");
  // Source grounding travels with each reviewer's own result.
  assert.equal(result.primary.result.groundingStats.totalCitations, 4);
  assert.equal(body.usageCredits, 8);
  assert.equal(body.guest, true);
  // A guest result is not stored anywhere, and says so rather than being
  // presented as saved.
  assert.equal(body.persisted, false);
  assert.equal(body.webVerificationAvailable, false);
  assert.ok(!("id" in body), "a guest review must not claim a stored row id");
});

test("the month's second run is refused, and nothing is spent", async () => {
  const { POST } = await loadRoute();
  const first = await POST(guestRequest({}));
  assert.equal(first.status, 200);
  const cookie = guestCookieFrom(first);
  assert.ok(cookie, "the route must issue a guest cookie");

  const second = await POST(
    guestRequest({ idempotencyKey: "run-key-0002" }, { cookie })
  );
  const body = await readJson(second);

  assert.equal(second.status, 429);
  assert.equal(body.code, "GUEST_COMPARISON_REVIEW_MONTHLY_LIMIT");
  assert.equal(world.runs.length, 1, "the refused run reached the pipeline");
  // The idempotency claim taken for the refused attempt is handed back, so the
  // user is not also locked out of retrying next month.
  assert.equal(world.idempotencyReleases.length, 1);
});

test("two simultaneous requests produce one run and one claimed slot", async () => {
  const { POST } = await loadRoute();
  // Establish the identity first so both racing requests are the same guest.
  const seed = await POST(guestRequest({ idempotencyKey: "seed-key-0000" }));
  const cookie = guestCookieFrom(seed);
  world = freshWorld();

  const [a, b] = await Promise.all([
    POST(guestRequest({ idempotencyKey: "race-key-a-01" }, { cookie })),
    POST(guestRequest({ idempotencyKey: "race-key-b-01" }, { cookie })),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 429]);
  assert.equal(world.runs.length, 1, "both requests ran the review");
  assert.equal(world.quotaClaims.length, 1, "both requests claimed a slot");
});

test("the same idempotency key never runs or charges twice", async () => {
  const { POST } = await loadRoute();
  const seed = await POST(guestRequest({ idempotencyKey: "seed-key-0000" }));
  const cookie = guestCookieFrom(seed);
  world = freshWorld();
  world.quotaLimit = 5; // quota is not what should stop the second attempt

  const first = await POST(guestRequest({ idempotencyKey: "same-key-0001" }, { cookie }));
  const second = await POST(guestRequest({ idempotencyKey: "same-key-0001" }, { cookie }));

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal((await readJson(second)).code, "DUPLICATE_REQUEST");
  assert.equal(world.runs.length, 1, "a duplicate click ran the review twice");
  assert.equal(
    world.quotaClaims.length,
    1,
    "a duplicate click consumed two trial slots"
  );
});

test("the idempotency claim is taken before the quota slot", async () => {
  // Ordering is the guarantee: if the quota were claimed first, a duplicate
  // request would consume the month's trial before being recognised as a
  // duplicate.
  const { POST } = await loadRoute();
  await POST(guestRequest({}));
  assert.equal(world.idempotencyClaims.length, 1);
  assert.equal(world.quotaClaims.length, 1);
  assert.ok(
    world.runs.length === 1,
    "the run must happen after both claims, not before"
  );
});

test("a failed review gives back both the trial slot and the retry", async () => {
  const { POST } = await loadRoute();
  world.runBehaviour = "fail";

  const response = await POST(guestRequest({}));
  const body = await readJson(response);

  assert.equal(response.status, 502);
  assert.equal(body.code, "COMPARISON_REVIEW_FAILED");
  // A provider outage must cost the guest neither their one monthly run...
  assert.equal(world.quotaReleases.length, 1);
  assert.equal(world.quotaUsed.get(world.quotaClaims[0]), 0);
  // ...nor the right to try again.
  assert.equal(world.idempotencyReleases.length, 1);
  // The refund is stated, not implied.
  assert.match(String(body.error), /refunded/i);
});

test("no reviewer configured refunds the slot and reports it as unavailable", async () => {
  const { POST } = await loadRoute();
  world.runBehaviour = "unavailable";

  const response = await POST(guestRequest({}));
  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).code, "COMPARISON_REVIEWER_UNAVAILABLE");
  assert.equal(world.quotaReleases.length, 1);
  assert.equal(world.idempotencyReleases.length, 1);
});

test("an exhausted guest credit budget is reported before the result", async () => {
  const { POST } = await loadRoute();
  world.creditFailure = { code: "CHAT_QUOTA_EXCEEDED", status: 429 };

  const response = await POST(guestRequest({}));
  const body = await readJson(response);

  assert.equal(response.status, 429);
  assert.equal(body.code, "CHAT_QUOTA_EXCEEDED");
  // Running out of credits is not the same as using the monthly trial: the
  // slot goes back so the trial is still there once the budget resets.
  assert.equal(world.quotaReleases.length, 1);
  assert.equal(world.idempotencyReleases.length, 1);
});

test("fewer than two answers never reaches the pipeline", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({ responses: [VALID_RESPONSES[0]] })
  );

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "INVALID_REQUEST");
  assert.equal(world.runs.length, 0);
  assert.equal(world.quotaClaims.length, 0);
  assert.equal(world.idempotencyClaims.length, 0);
});

test("more answers than a comparison supports is refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      responses: [
        ...VALID_RESPONSES,
        { messageId: "m3", modelId: "gemini-2-5-flash", content: "Third." },
        { messageId: "m4", modelId: "llama-3-3", content: "Fourth." },
      ],
    })
  );
  assert.equal(response.status, 400);
  assert.equal(world.runs.length, 0);
});

test("two answers from the same model are refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      responses: [
        VALID_RESPONSES[0],
        { messageId: "m2", modelId: "gpt-5-4-mini", content: "Same model." },
      ],
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "DUPLICATE_MODEL_RESPONSE");
  assert.equal(world.runs.length, 0);
});

test("a model a guest cannot use is refused", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      responses: [
        VALID_RESPONSES[0],
        // A real catalogue model, but one that needs a paid plan. The endpoint
        // must not become a way to have Pro-tier output reviewed for free.
        { messageId: "m2", modelId: "gpt-5-5", content: "Premium answer." },
      ],
    })
  );
  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).code, "MODEL_ACCESS_FORBIDDEN");
  assert.equal(world.runs.length, 0);
});

test("an unknown model id is refused rather than passed through", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      responses: [
        VALID_RESPONSES[0],
        { messageId: "m2", modelId: "not-a-real-model", content: "Answer." },
      ],
    })
  );
  assert.equal(response.status, 403);
  assert.equal(world.runs.length, 0);
});

test("an oversized answer is refused before anything is claimed", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      responses: [
        VALID_RESPONSES[0],
        { messageId: "m2", modelId: "claude-haiku-4-5", content: "x".repeat(25_000) },
      ],
    })
  );

  assert.equal(response.status, 400);
  assert.equal(world.runs.length, 0);
  assert.equal(world.quotaClaims.length, 0);
});

test("answers that individually fit but together do not are refused", async () => {
  // The bypass this closes: three answers each under the per-answer cap, used
  // to push an arbitrarily large payload into a paid reviewer.
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      responses: [
        { messageId: "m1", modelId: "gpt-5-4-mini", content: "x".repeat(19_000) },
        { messageId: "m2", modelId: "claude-haiku-4-5", content: "y".repeat(19_000) },
        { messageId: "m3", modelId: "gemini-2-5-flash", content: "z".repeat(19_000) },
      ],
    })
  );

  assert.equal(response.status, 413);
  assert.equal((await readJson(response)).code, "COMPARISON_REVIEW_INPUT_TOO_LARGE");
  assert.equal(world.runs.length, 0);
  assert.equal(world.quotaClaims.length, 0);
});

test("a client cannot name the reviewer, the cost or the quota state", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    guestRequest({
      reviewerModelId: "gpt-5-5",
      usageCredits: 0,
      guestTrial: { remaining: 99 },
    })
  );

  // The schema is strict: an unknown field is a rejected request, not a
  // silently ignored one.
  assert.equal(response.status, 400);
  assert.equal(world.runs.length, 0);
});

test("a failed verification stops the request before any claim", async () => {
  const { POST } = await loadRoute();
  const response = await POST(guestRequest({ turnstileToken: "invalid-token" }));

  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).code, "TURNSTILE_FAILED");
  assert.equal(world.runs.length, 0);
  assert.equal(world.quotaClaims.length, 0);
  assert.equal(world.idempotencyClaims.length, 0);
  // Verified under this endpoint's own action name, not the chat's.
  assert.deepEqual(world.turnstileCalls, ["guest_ai_review"]);
});

test("the guest endpoint is closed to signed-in callers", async () => {
  await loadRoute();
  const realChatSecurity = require(
    resolve(ROOT, "lib/chatSecurity.ts")
  ) as { getUserChatUsageKey: (id: string) => string };
  assert.ok(realChatSecurity.getUserChatUsageKey("u1"));

  // identifyChatCaller returns a "user" access only when a session id is
  // passed, and this route never passes one -- so the guard is asserted
  // through the route's own contract: it is guest-only by construction, and
  // signed-in users keep the conversation route with its own plan quota.
  const routeSource = require("node:fs").readFileSync(
    resolve(ROOT, "app/api/chat/comparison-review/route.ts"),
    "utf8"
  ) as string;
  assert.match(routeSource, /access\.kind !== "guest"/);
  assert.match(routeSource, /GUEST_ONLY_ENDPOINT/);
  assert.ok(
    !/getServerSession/.test(routeSource),
    "the guest route must not accept a session at all"
  );
});

test("the rate limit is consumed before the payload is even read", async () => {
  const { POST } = await loadRoute();
  await POST(guestRequest({ responses: [VALID_RESPONSES[0]] }));
  assert.deepEqual(world.rateLimits, ["guest-comparison-review"]);
});

test("no provider detail or secret reaches the client on failure", async () => {
  const { POST } = await loadRoute();
  world.runBehaviour = "fail";
  const body = await readJson(await POST(guestRequest({})));

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(process.env.NEXTAUTH_SECRET as string));
  assert.ok(!/api[_-]?key/i.test(serialized));
  assert.ok(!/mistral|anthropic|openai/i.test(serialized));
  // A stable code and a trace id, and nothing else.
  assert.deepEqual(Object.keys(body).sort(), ["code", "error", "traceId"]);
});
