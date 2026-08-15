import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for GET /api/admin/users/[userId].
 *
 * The response is assembled by hand from a wide Prisma selection, and several
 * of the columns it names are `BigInt` -- the micro-USD money columns, and
 * `ChatUsageBucket."count"`, which is BigInt because the operational cost
 * guardrails derived from the Max plan's credit grant pass int4 (see
 * docs/policy/credit-and-cost-limits.md). `NextResponse.json()` is
 * `JSON.stringify`, which throws `TypeError: Do not know how to serialize a
 * BigInt`, so every one of those columns has to be narrowed on the way out.
 *
 * Missing one is invisible until a customer actually has the row: a `bigint`
 * only reaches the serializer when the query returns something, and the route's
 * catch turns the TypeError into a flat 500 that the panel renders as "Failed
 * to load user detail." That is what happened to `usage.creditsToday` and
 * `usage.creditsMonth` -- `row?.count || 0` is a plain `number` for an absent
 * row *and* for a stored zero, so only customers with real usage failed.
 *
 * What must hold:
 *   - a customer whose day and month usage buckets exist gets 200, with the
 *     counts as JSON numbers rather than strings or an error;
 *   - a customer with no usage rows still reads 0, exactly as before;
 *   - every other BigInt-backed column in the selection is a JSON number too;
 *   - a count outside JavaScript's exact integer range fails closed rather than
 *     being silently rounded into the response.
 *
 * Only the session, admin auth and the rate limiter are replaced, plus Prisma
 * itself. `getUserChatUsageKey`, `getZonedDayWindow` and the whole response
 * assembly are the real ones.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "admin-user-detail-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const USER_ID = "cmnh9593400010pmqaguj6q2";

type UsageRow = {
  period: string;
  count: bigint;
  updatedAt: Date;
};

type World = {
  session: { user: { id: string; email?: string } } | null;
  isAdmin: boolean;
  userExists: boolean;
  usageRows: UsageRow[];
  errors: string[];
};

const freshWorld = (): World => ({
  session: { user: { id: "admin_1", email: "admin@tomverse.app" } },
  isAdmin: true,
  userExists: true,
  usageRows: [],
  errors: [],
});

let world = freshWorld();
let mocksInstalled = false;

/**
 * A customer row shaped like the route's `select`, with a real `bigint` in
 * every BigInt-typed column it asks for. Prisma returns `bigint` for those
 * regardless of magnitude, so small values are just as unserializable as large
 * ones -- which is the point.
 */
const customerRecord = () => ({
  id: USER_ID,
  email: "customer@example.com",
  name: "Usage Carrier",
  image: null,
  plan: "Pro",
  stripeCustomerId: "cus_contract",
  stripeSubscriptionId: "sub_contract",
  stripePriceId: "price_contract",
  subscriptionStatus: "active",
  subscriptionCurrentPeriodEnd: new Date("2099-02-01T00:00:00.000Z"),
  subscriptionBillingInterval: "month",
  subscriptionCancelAtPeriodEnd: false,
  creditDebtCredits: 12,
  creditDebtCostMicroUsd: BigInt(480_000),
  billingRiskStatus: "none",
  billingRiskReason: null,
  billingRiskAt: null,
  accountStatus: "active",
  accountDeletionRequestedAt: null,
  accountDeletionScheduledFor: null,
  accountSuspendedAt: null,
  accountSuspendedUntil: null,
  accountSuspensionReason: null,
  aiUsageRestricted: false,
  aiUsageRestrictedAt: null,
  aiUsageRestrictedUntil: null,
  aiUsageRestrictionReason: null,
  securityIncidentNote: null,
  lastLoginAt: new Date("2099-01-05T00:00:00.000Z"),
  settings: {
    language: "ko",
    theme: "dark",
    defaultModel: "gpt-5-6-luna",
    timeZone: "UTC",
    updatedAt: new Date("2099-01-04T00:00:00.000Z"),
  },
  accounts: [
    { provider: "google", providerAccountId: "google-1", type: "oauth" },
  ],
  refundRequests: [
    {
      id: "refund_1",
      status: "pending",
      plan: "Pro",
      reason: "duplicate charge",
      requestedAt: new Date("2099-01-03T00:00:00.000Z"),
      reviewedAt: null,
      stripeRefundStatus: null,
      refundAmountCents: 2_000,
    },
  ],
  promotionRedemptions: [
    {
      id: "redemption_1",
      planId: "pro",
      billingInterval: "month",
      redeemedAt: new Date("2099-01-02T00:00:00.000Z"),
      stripeCheckoutSessionId: "cs_contract",
      promotion: {
        code: "LAUNCH",
        discountPercent: 20,
        discountAmountCents: null,
      },
    },
  ],
  creditPurchases: [
    {
      id: "purchase_1",
      packId: "credits-1000",
      creditsPurchased: 1_000,
      fundedCostMicroUsd: BigInt(40_000_000),
      amountPaidCents: 1_000,
      amountPaidUsdMicroUsd: BigInt(10_000_000),
      currency: "USD",
      refundedAmountCents: 0,
      revokedCredits: 0,
      revokedCostMicroUsd: BigInt(0),
      unrecoveredCredits: 0,
      unrecoveredCostMicroUsd: BigInt(0),
      stripeCheckoutSessionId: "cs_purchase",
      stripePaymentIntentId: "pi_purchase",
      stripeChargeId: "ch_purchase",
      stripeDisputeId: null,
      disputeStatus: null,
      status: "paid",
      purchasedAt: new Date("2099-01-01T00:00:00.000Z"),
      expiresAt: new Date("2099-06-01T00:00:00.000Z"),
      lots: [
        {
          remainingCredits: 640,
          remainingFundedCostMicroUsd: BigInt(25_600_000),
          status: "active",
        },
      ],
    },
  ],
  creditDebtEntries: [
    {
      id: "debt_1",
      purchaseId: "purchase_1",
      type: "dispute",
      creditsDelta: -12,
      fundedCostMicroUsdDelta: -BigInt(480_000),
      balanceAfterCredits: 12,
      balanceAfterCostMicroUsd: BigInt(480_000),
      createdAt: new Date("2099-01-03T12:00:00.000Z"),
    },
  ],
  chatCreditReservations: [
    {
      id: "reservation_1",
      traceId: "trace_1",
      source: "chat",
      provider: "openai",
      modelId: "gpt-5-6-luna",
      status: "settled",
      outcome: "success",
      providerRequestId: "req_1",
      providerResponseId: "resp_1",
      reservedCredits: 8,
      settledCredits: 5,
      reservedCostMicroUsd: BigInt(320_000),
      settledCostMicroUsd: BigInt(200_000),
      expiresAt: new Date("2099-01-03T13:00:00.000Z"),
      settledAt: new Date("2099-01-03T12:30:00.000Z"),
      reconciledAt: null,
      lastError: null,
      createdAt: new Date("2099-01-03T12:00:00.000Z"),
    },
  ],
  privacyRequests: [
    {
      id: "privacy_1",
      requestType: "export",
      status: "open",
      dueAt: new Date("2099-02-01T00:00:00.000Z"),
      legalHold: false,
      createdAt: new Date("2099-01-03T00:00:00.000Z"),
    },
  ],
  _count: {
    conversations: 3,
    accounts: 1,
    refundRequests: 1,
    promotionRedemptions: 1,
    sessions: 2,
    creditPurchases: 1,
    chatCreditReservations: 1,
  },
});

async function loadRoute(): Promise<{
  GET: (
    request: Request,
    context: { params: Promise<{ userId: string }> }
  ) => Promise<Response>;
}> {
  if (!mocksInstalled) {
    mocksInstalled = true;

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => world.session,
      },
    });

    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.isAdmin,
        hasAdminPermission: () => true,
      },
    });

    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
      string,
      unknown
    >;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => {},
      },
    });

    const fakePrisma: Record<string, unknown> = {
      userSettings: {
        findUnique: async () => ({ timeZone: "UTC" }),
      },
      user: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.userExists && where.id === USER_ID ? customerRecord() : null,
      },
      chatUsageBucket: {
        findMany: async () => world.usageRows.map((row) => ({ ...row })),
      },
      conversation: {
        findMany: async () => [
          {
            id: "conversation_1",
            title: "A conversation with history",
            shareEnabled: false,
            createdAt: new Date("2099-01-01T00:00:00.000Z"),
            updatedAt: new Date("2099-01-03T00:00:00.000Z"),
            _count: { messages: 24 },
          },
        ],
      },
      adminAuditLog: {
        findMany: async () => [],
      },
      message: {
        count: async () => 24,
      },
    };
    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
  }

  return import(mod("app/api/admin/users/[userId]/route.ts")) as never;
}

const readDetail = async () => {
  const { GET } = await loadRoute();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "));
  };
  try {
    const response = await GET(
      new Request(`http://127.0.0.1:3100/api/admin/users/${USER_ID}`),
      { params: Promise.resolve({ userId: USER_ID }) }
    );
    // Read the body as text first: a serialization failure inside the response
    // would surface here, not at `NextResponse.json()`.
    const text = await response.text();
    return { response, text, body: JSON.parse(text), errors };
  } finally {
    console.error = originalError;
  }
};

const usageRow = (period: string, count: bigint): UsageRow => ({
  period,
  count,
  updatedAt: new Date("2099-01-03T12:00:00.000Z"),
});

test("a customer carrying day and month usage buckets is served, not failed", async () => {
  world = freshWorld();
  // Prisma hands back `bigint` for a BigInt column at any magnitude, so these
  // are the values a real customer with a single day of chat produces.
  world.usageRows = [usageRow("day", BigInt(17)), usageRow("month", BigInt(412))];

  const { response, text, body, errors } = await readDetail();

  assert.equal(
    response.status,
    200,
    `expected 200, got ${response.status}: ${text}`
  );
  assert.deepEqual(errors, [], "the route must not have logged a failure");
  assert.equal(body.user.usage.creditsToday, 17);
  assert.equal(body.user.usage.creditsMonth, 412);
  assert.equal(typeof body.user.usage.creditsToday, "number");
  assert.equal(typeof body.user.usage.creditsMonth, "number");
  // Narrowed to a JSON number, not stringified around the serializer.
  assert.match(text, /"creditsToday":17\b/);
  assert.match(text, /"creditsMonth":412\b/);
});

test("a customer with no usage rows still reads zero", async () => {
  world = freshWorld();
  world.usageRows = [];

  const { response, body, errors } = await readDetail();

  assert.equal(response.status, 200);
  assert.deepEqual(errors, []);
  assert.equal(body.user.usage.creditsToday, 0);
  assert.equal(body.user.usage.creditsMonth, 0);
});

test("a stored zero reads zero without becoming a string", async () => {
  world = freshWorld();
  // A stored zero already produced a number, which is exactly why an untouched
  // zero bucket never revealed the bug. It must keep reading 0 after the fix.
  world.usageRows = [usageRow("day", BigInt(0)), usageRow("month", BigInt(0))];

  const { response, body, errors } = await readDetail();

  assert.equal(response.status, 200);
  assert.deepEqual(errors, []);
  assert.equal(body.user.usage.creditsToday, 0);
  assert.equal(body.user.usage.creditsMonth, 0);
});

test("only the day and month buckets are read, and neither is mistaken for the other", async () => {
  world = freshWorld();
  world.usageRows = [usageRow("month", BigInt(9_001)), usageRow("day", BigInt(3))];

  const { response, body } = await readDetail();

  assert.equal(response.status, 200);
  assert.equal(body.user.usage.creditsToday, 3);
  assert.equal(body.user.usage.creditsMonth, 9_001);
});

test("a guardrail-sized count past int4 survives the read", async () => {
  world = freshWorld();
  // The Max plan's derived monthly total-cost guardrail, the value that forced
  // the column to BigInt in the first place.
  world.usageRows = [usageRow("day", BigInt(2_500_000_000)), usageRow("month", BigInt(2_500_000_000))];

  const { response, body, errors } = await readDetail();

  assert.equal(response.status, 200);
  assert.deepEqual(errors, []);
  assert.equal(body.user.usage.creditsToday, 2_500_000_000);
  assert.equal(body.user.usage.creditsMonth, 2_500_000_000);
});

test("every other BigInt-backed column in the selection is a JSON number", async () => {
  world = freshWorld();
  world.usageRows = [usageRow("day", BigInt(17)), usageRow("month", BigInt(412))];

  const { response, body } = await readDetail();

  assert.equal(response.status, 200);
  const user = body.user;
  assert.equal(user.creditDebtCostMicroUsd, 480_000);
  const purchase = user.creditPurchases[0];
  assert.equal(purchase.fundedCostMicroUsd, 40_000_000);
  assert.equal(purchase.amountPaidUsdMicroUsd, 10_000_000);
  assert.equal(purchase.revokedCostMicroUsd, 0);
  assert.equal(purchase.unrecoveredCostMicroUsd, 0);
  assert.equal(purchase.remainingFundedCostMicroUsd, 25_600_000);
  assert.equal(purchase.lots[0].remainingFundedCostMicroUsd, 25_600_000);
  const debt = user.creditDebtEntries[0];
  assert.equal(debt.fundedCostMicroUsdDelta, -480_000);
  assert.equal(debt.balanceAfterCostMicroUsd, 480_000);
  const reservation = user.chatCreditReservations[0];
  assert.equal(reservation.reservedCostMicroUsd, 320_000);
  assert.equal(reservation.settledCostMicroUsd, 200_000);

  for (const [path, value] of walk(body)) {
    assert.notEqual(
      typeof value,
      "bigint",
      `${path} reached the response as a bigint`
    );
  }
});

test("a count outside the exact integer range fails closed instead of rounding", async () => {
  world = freshWorld();
  world.usageRows = [
    usageRow("day", BigInt(3)),
    usageRow("month", BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2)),
  ];

  const { response, body, errors } = await readDetail();

  assert.equal(response.status, 500);
  assert.equal(body.error, "Failed to load user detail.");
  assert.equal(body.user, undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /supported range/);
});

test("the detail still carries the usage context and recent conversations", async () => {
  world = freshWorld();
  world.usageRows = [usageRow("day", BigInt(17)), usageRow("month", BigInt(412))];

  const { response, body } = await readDetail();

  assert.equal(response.status, 200);
  assert.equal(body.user.usage.timeZone, "UTC");
  assert.equal(body.user.usage.messagesToday, 24);
  assert.equal(body.user.recentConversations.length, 1);
  assert.equal(
    body.user.recentConversations[0].title,
    "A conversation with history"
  );
});

/** Every leaf in the parsed response, with the path that reached it. */
function* walk(
  value: unknown,
  path = "$"
): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      yield* walk(entry, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      yield* walk(entry, `${path}.${key}`);
    }
    return;
  }
  yield [path, value];
}
