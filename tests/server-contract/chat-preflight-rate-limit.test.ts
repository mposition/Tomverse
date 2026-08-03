import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The HTTP contract of a rate-limited comparison preflight.
//
// The database side -- that a three-model comparison reserves three units of
// per-minute capacity atomically, or none -- is pinned in
// tests/integration/chat-rate-limit.db.test.ts. What is pinned here is what
// POST /api/chat/preflight actually puts on the wire when that reservation is
// refused, because that is all the browser ever sees:
//
//   * 429, not 402 or 403 -- this resolves by waiting, not by paying;
//   * `code: "CHAT_RATE_LIMITED"`, the code the client already switches on;
//   * a `Retry-After` header of at least one second;
//   * `details.retryAfterSeconds` agreeing with that header;
//   * a `scope` that says whether the caller's own allowance or the network's
//     ceiling refused;
//   * a `limitLayer` that is not `entitlement`;
//   * an `X-Request-ID` so the Trace ID on screen resolves to this decision;
//   * and no internal micro-USD anywhere in the body.
//
// The reservation itself is replaced here so the assertions are about the
// route's translation rather than about a database.

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
process.env.CHAT_GUEST_PER_MINUTE ||= "5";
process.env.CHAT_IP_PER_MINUTE ||= "40";

type Rejection = {
  scope: "subject" | "ip";
  limit: number;
  used: number;
  requested: number;
  retryAfterSeconds: number;
};

let pendingRejection: Rejection | null = null;
let preflightCalls = 0;
let mocksInstalled = false;

/**
 * Loads the real preflight route with only the aggregate reservation replaced.
 *
 * The replacement builds its refusal out of the same pure helpers the real
 * reservation uses, so the details asserted below are the ones production
 * produces rather than a hand-written imitation that could drift from them.
 */
async function loadPreflightRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
}> {
  if (mocksInstalled) {
    return (await import(`${mod("app/api/chat/preflight/route.ts")}?spy=cached`)) as {
      POST: (request: Request) => Promise<Response>;
    };
  }
  mocksInstalled = true;

  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;

  const realChatSecurity = original("lib/chatSecurity.ts");
  const rateCore = original("lib/chatRateLimitCore.ts") as {
    CHAT_RATE_LIMITED: string;
    ipRateScope: (key: string, limit: number) => Record<string, unknown>;
    subjectRateScope: (
      kind: string,
      key: string,
      limit: number
    ) => Record<string, unknown>;
    rateLimitRejectionDetails: (
      scope: unknown,
      input: Record<string, unknown>
    ) => Record<string, unknown>;
    rateLimitRejectionMessage: (scope: string) => string;
  };
  const ChatAccessError = realChatSecurity.ChatAccessError as new (
    status: number,
    code: string,
    message: string,
    retryAfter?: number,
    details?: Record<string, unknown>
  ) => Error;

  mock.module(mod("lib/chatSecurity.ts"), {
    namedExports: {
      ...realChatSecurity,
      preflightChatComparisonAccess: async () => {
        preflightCalls += 1;
        const rejection = pendingRejection;
        if (!rejection) {
          throw new Error(
            "This suite only drives the refused path; nothing should reach an allowed one."
          );
        }
        const scope =
          rejection.scope === "ip"
            ? rateCore.ipRateScope("ip:hashed", rejection.limit)
            : rateCore.subjectRateScope(
                "guest",
                "guest:hashed",
                rejection.limit
              );
        throw new ChatAccessError(
          429,
          rateCore.CHAT_RATE_LIMITED,
          rateCore.rateLimitRejectionMessage(rejection.scope),
          rejection.retryAfterSeconds,
          {
            ...rateCore.rateLimitRejectionDetails(scope, {
              usedRequests: rejection.used,
              requestedRequests: rejection.requested,
              retryAfterSeconds: rejection.retryAfterSeconds,
              resetAt: new Date(Date.now() + rejection.retryAfterSeconds * 1000),
            }),
            // Present precisely so the assertion below can prove the route
            // strips it: internal spend never reaches an end user.
            internalLimitCostMicroUsd: 123_456,
          }
        );
      },
    },
  });

  // The route's own per-endpoint throttle is a database write, and this suite
  // runs without one. Neutralised so the request reaches the seam under test;
  // its own behaviour is unrelated to what a rate refusal puts on the wire.
  const realApiSecurity = original("lib/apiSecurity.ts");
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ...realApiSecurity,
      consumeApiRateLimit: async () => undefined,
    },
  });

  mock.module("next-auth/next", {
    namedExports: { getServerSession: async () => null },
  });

  return (await import(`${mod("app/api/chat/preflight/route.ts")}?spy=cached`)) as {
    POST: (request: Request) => Promise<Response>;
  };
}

const TRACE_ID = "c7216139-abb3-43c9-8735-f6a2206db9a7";

const preflightRequest = (traceId = TRACE_ID) =>
  new Request("http://127.0.0.1:3100/api/chat/preflight", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Request-ID": traceId,
    },
    body: JSON.stringify({
      comparisonId: "1754000000000",
      conversationId: "private-chat",
      modelIds: ["gpt-5-6-luna", "gpt-5-4-mini"],
      prompt: "compare these",
      attachments: [],
    }),
  });

type RejectionBody = {
  code?: string;
  error?: string;
  details?: Record<string, unknown>;
};

const refuse = async (rejection: Rejection) => {
  const { POST } = await loadPreflightRoute();
  pendingRejection = rejection;
  const before = preflightCalls;
  const response = await POST(preflightRequest());
  assert.equal(
    preflightCalls,
    before + 1,
    "the route must reach the aggregate reservation"
  );
  return { response, body: (await response.json()) as RejectionBody };
};

test("a subject rate refusal is a 429 the client can count down from", async () => {
  const { response, body } = await refuse({
    scope: "subject",
    limit: 5,
    used: 3,
    requested: 3,
    retryAfterSeconds: 6,
  });

  // Not 402: nothing about this is a balance, and offering to sell credits to
  // someone who has to wait six seconds is the wrong answer.
  assert.equal(response.status, 429);
  assert.equal(body.code, "CHAT_RATE_LIMITED");
  assert.equal(response.headers.get("Retry-After"), "6");
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
  assert.equal(body.details?.retryAfterSeconds, 6);
  assert.equal(
    body.details?.retryAfterSeconds,
    Number(response.headers.get("Retry-After")),
    "the header and the body must not disagree about the wait"
  );
  assert.equal(body.details?.scope, "guest_rate_minute");
  assert.equal(body.details?.limitLayer, "rate_limit");
  assert.notEqual(body.details?.limitLayer, "entitlement");
  // Support resolves the Trace ID the user reads off the screen to this call.
  assert.equal(response.headers.get("X-Request-ID"), TRACE_ID);
  const resetAt = new Date(String(body.details?.resetAt));
  assert.ok(resetAt.getTime() > Date.now(), "resetAt must be in the future");
});

test("an IP rate refusal is distinguishable from the caller's own", async () => {
  const { response, body } = await refuse({
    scope: "ip",
    limit: 40,
    used: 39,
    requested: 3,
    retryAfterSeconds: 12,
  });

  assert.equal(response.status, 429);
  assert.equal(body.code, "CHAT_RATE_LIMITED");
  assert.equal(body.details?.scope, "ip_rate_minute");
  assert.equal(body.details?.limitLayer, "operational_admission");
  assert.notEqual(body.details?.scope, "guest_rate_minute");
  assert.equal(response.headers.get("Retry-After"), "12");
  assert.equal(body.details?.retryAfterSeconds, 12);
  assert.match(String(body.error), /network/i);
});

test("a rate refusal never exposes internal spend", async () => {
  const { body } = await refuse({
    scope: "subject",
    limit: 5,
    used: 4,
    requested: 2,
    retryAfterSeconds: 1,
  });

  const serialised = JSON.stringify(body);
  assert.doesNotMatch(serialised, /internal/i);
  assert.doesNotMatch(serialised, /123456|123_456/);
  for (const key of Object.keys(body.details ?? {})) {
    assert.doesNotMatch(key, /^internal/);
  }
  // A wait is never advertised as zero.
  assert.ok(Number(body.details?.retryAfterSeconds) >= 1);
});

test("the refusal message talks about waiting, not about credits", async () => {
  const { body } = await refuse({
    scope: "subject",
    limit: 5,
    used: 5,
    requested: 3,
    retryAfterSeconds: 30,
  });

  assert.doesNotMatch(String(body.error), /credit|plan|upgrade|budget|\$/i);
  assert.match(String(body.error), /too quickly|wait/i);
});
