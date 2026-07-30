import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The monthly trial quota and the idempotency claim, asserted at the SQL they
 * emit.
 *
 * This is where their correctness actually lives. A read-then-write would pass
 * every single-threaded test in the suite and still let two simultaneous
 * clicks both take the last slot -- what makes that impossible is that the
 * insert and the limit check are one statement, so the loser gets zero rows
 * back instead of an over-count. Asserting the statement is asserting the
 * property; asserting a counter would not.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "guest-review-quota-contract-secret";

type Statement = { sql: string; values: unknown[] };

const statements: Statement[] = [];
const updates: unknown[] = [];
/** Rows the next $queryRaw should return; empty means "the guard declined". */
let nextRows: Array<Array<{ count: number }>> = [];

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        return Promise.resolve(nextRows.shift() ?? [{ count: 1 }]);
      },
      chatUsageBucket: {
        findUnique: () => Promise.resolve({ count: 0 }),
        updateMany: (args: unknown) => {
          updates.push(args);
          return Promise.resolve({ count: 1 });
        },
      },
    },
  },
});

type QuotaModule = typeof import("../../lib/comparisonReviewQuota");
type IdempotencyModule = typeof import("../../lib/guestIdempotency");

// Loaded lazily rather than at the top level: this file is transformed to CJS
// by tsx, which has no top-level await, and the modules must be imported after
// the prisma mock above is registered either way.
let quota: QuotaModule;
let idempotency: IdempotencyModule;

test.before(async () => {
  quota = (await import(mod("lib/comparisonReviewQuota.ts"))) as QuotaModule;
  idempotency = (await import(mod("lib/guestIdempotency.ts"))) as IdempotencyModule;
});

test.beforeEach(() => {
  statements.length = 0;
  updates.length = 0;
  nextRows = [];
});

/** The shape that makes a claim atomic rather than merely usually-correct. */
const assertAtomicClaim = (statement: Statement) => {
  assert.match(statement.sql, /INSERT INTO "ChatUsageBucket"/);
  assert.match(statement.sql, /ON CONFLICT \("key", "period", "periodStart"\)/);
  assert.match(statement.sql, /DO UPDATE SET/);
  assert.match(
    statement.sql,
    /WHERE "ChatUsageBucket"\."count" < \?/,
    "the limit check must be part of the same statement as the increment"
  );
  assert.match(statement.sql, /RETURNING "count"/);
  // No read-then-write anywhere: exactly one round trip.
  assert.equal(statements.length, 1);
};

test("the guest monthly trial is claimed in one conditional statement", async () => {
  assert.equal(quota.getGuestComparisonReviewLimit(), 1);
  const reservation = await quota.reserveGuestComparisonReview("guest:abc");

  assertAtomicClaim(statements[0]);
  const { values } = statements[0];
  assert.ok(values.includes("guest-comparison-review-month"));
  assert.ok(values.includes("guest:abc:guest-comparison-review"));
  // The limit is a bound parameter, never interpolated into the SQL text.
  assert.ok(values.includes(1));
  assert.equal(reservation.period, "guest-comparison-review-month");
});

test("the trial limit is configurable without touching the UI or the API", async () => {
  const previous = process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH;
  process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH = "3";
  try {
    assert.equal(quota.getGuestComparisonReviewLimit(), 3);
    await quota.reserveGuestComparisonReview("guest:abc");
    assert.ok(statements[0].values.includes(3));
  } finally {
    if (previous === undefined) delete process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH;
    else process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH = previous;
  }
  // A nonsense value falls back to the documented default rather than opening
  // the trial up.
  process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH = "-4";
  assert.equal(quota.getGuestComparisonReviewLimit(), 1);
  delete process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH;
});

test("the loser of a race is refused with its own error code", async () => {
  nextRows = [[]];
  await assert.rejects(
    () => quota.reserveGuestComparisonReview("guest:abc"),
    (error: Error & { code?: string; status?: number }) => {
      assert.equal(error.code, "GUEST_COMPARISON_REVIEW_MONTHLY_LIMIT");
      assert.equal(error.status, 429);
      return true;
    }
  );
});

test("the Free plan's three-per-month policy is unchanged", async () => {
  assert.equal(quota.getFreeComparisonReviewLimit(), 3);
  await quota.reserveFreeComparisonReview("user:abc");

  assertAtomicClaim(statements[0]);
  const { values } = statements[0];
  // The same bucket name and key suffix as before this change, so rows already
  // counted this month keep counting.
  assert.ok(values.includes("comparison-review-month"));
  assert.ok(values.includes("user:abc:comparison-review"));
  assert.ok(values.includes(3));
});

test("a released slot is decremented, never below zero", async () => {
  await quota.releaseComparisonReviewQuota({
    key: "guest:abc:guest-comparison-review",
    period: "guest-comparison-review-month",
    periodStart: new Date(0),
  });
  const [update] = updates as Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>;
  assert.equal(update.where.period, "guest-comparison-review-month");
  assert.deepEqual(update.where.count, { gt: 0 });
  assert.deepEqual(update.data, { count: { decrement: 1 } });
});

test("the guest and Free buckets are separate, so one cannot spend the other", async () => {
  await quota.reserveGuestComparisonReview("subject:x");
  await quota.reserveFreeComparisonReview("subject:x");
  const [guestClaim, freeClaim] = statements;
  assert.notDeepEqual(guestClaim.values, freeClaim.values);
  assert.ok(guestClaim.values.includes("guest-comparison-review-month"));
  assert.ok(freeClaim.values.includes("comparison-review-month"));
});

test("an idempotency key is claimed once, and never stored in the clear", async () => {
  await idempotency.claimGuestIdempotencyKey(
    "guest:abc",
    "comparison-review",
    "client-key-1234"
  );

  assertAtomicClaim(statements[0]);
  const { values } = statements[0];
  assert.ok(values.includes("guest-idempotency-comparison-review-day"));
  // The limit is 1: a key may be claimed exactly once.
  assert.ok(values.includes(1));

  const storedKey = values.find(
    (value): value is string =>
      typeof value === "string" && value.startsWith("idem:")
  );
  assert.ok(storedKey);
  // The client's raw key never reaches storage, so one guest cannot probe or
  // collide with another's claims by guessing keys.
  assert.ok(!storedKey.includes("client-key-1234"));
  assert.match(storedKey, /^idem:[0-9a-f]{64}$/);
});

test("the same key from two different guests is two different claims", async () => {
  await idempotency.claimGuestIdempotencyKey("guest:aaa", "comparison-review", "shared-key-1");
  await idempotency.claimGuestIdempotencyKey("guest:bbb", "comparison-review", "shared-key-1");
  const keys = statements.map(({ values }) =>
    values.find(
      (value): value is string =>
        typeof value === "string" && value.startsWith("idem:")
    )
  );
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("a replayed key is refused with a distinct, retryable-safe code", async () => {
  nextRows = [[]];
  await assert.rejects(
    () =>
      idempotency.claimGuestIdempotencyKey(
        "guest:abc",
        "comparison-review",
        "client-key-1234"
      ),
    (error: Error & { code?: string; status?: number }) => {
      // 409, not 429: the caller is not over a limit, they sent the same
      // request twice, and the UI says something different about each.
      assert.equal(error.code, "DUPLICATE_REQUEST");
      assert.equal(error.status, 409);
      return true;
    }
  );
});
