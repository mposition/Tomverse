import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The account AI Review in-flight claim, asserted at the SQL it emits and at
 * the TTL it is given.
 *
 * The route's use of the claim is exercised in
 * tests/server-contract/comparison-review-route.test.ts against an in-memory
 * stand-in. What only this file can show is that the stand-in is honest: the
 * claim is one conditional statement (two racing requests cannot both win), a
 * stale claim can be taken over (a dead process cannot lock a review out for
 * good), and a release removes only the holder's own claim.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "comparison-review-run-claim-secret";

type Statement = { sql: string; values: unknown[] };

const statements: Statement[] = [];
const deletes: Array<{ where: Record<string, unknown> }> = [];
/** Rows the next $queryRaw should return; empty means "the guard declined". */
let nextRows: Array<Array<{ count: bigint }>> = [];
/** Rows the next $executeRaw reports as changed. */
let nextChanged: number[] = [];

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        return Promise.resolve(nextRows.shift() ?? [{ count: BigInt(1) }]);
      },
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        return Promise.resolve(nextChanged.shift() ?? 1);
      },
      chatUsageBucket: {
        deleteMany: (args: { where: Record<string, unknown> }) => {
          deletes.push(args);
          return Promise.resolve({ count: 1 });
        },
        updateMany: () => Promise.resolve({ count: 1 }),
      },
    },
  },
});

type ClaimModule = typeof import("../../lib/guestIdempotency");
type InFlightModule = typeof import("../../lib/comparisonReviewInFlight");
type ReviewModule = typeof import("../../lib/comparisonReview");

let claims: ClaimModule;
let inFlight: InFlightModule;
let review: ReviewModule;

test.before(async () => {
  claims = (await import(mod("lib/guestIdempotency.ts"))) as ClaimModule;
  inFlight = (await import(mod("lib/comparisonReviewInFlight.ts"))) as InFlightModule;
  review = (await import(mod("lib/comparisonReview.ts"))) as ReviewModule;
});

test.beforeEach(() => {
  statements.length = 0;
  deletes.length = 0;
  nextRows = [];
  nextChanged = [];
});

test("a live run renews only its own claim, and only its timestamp", async () => {
  const claim = await claims.claimInFlightRun(SUBJECT, "comparison-review", RUN_KEY, 900);
  statements.length = 0;
  nextChanged = [1, 0];
  assert.equal(await claims.renewInFlightRun(claim), true);
  // The claim was taken over (or released): nothing is changed, and it says so.
  assert.equal(await claims.renewInFlightRun(claim), false);

  const [{ sql, values }] = statements;
  assert.match(sql, /^\s*UPDATE "ChatUsageBucket"\s+SET "updatedAt" = NOW\(\)\s+WHERE/);
  assert.doesNotMatch(sql, /"count" =\s*[^?]*,|SET[^W]*"count"/, "a renewal must not touch the token");
  assert.match(sql, /AND "count" = \?/, "a renewal must be conditional on the holder's token");
  assert.deepEqual(values, [claim.key, claim.period, claim.periodStart, claim.token]);
});

test("a live run renews well inside the TTL", () => {
  assert.ok(
    inFlight.COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS * 3 <= inFlight.COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000,
    "the heartbeat must be at most a third of the TTL"
  );
  assert.ok(inFlight.COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS >= 1000);
});

const SUBJECT = "user:subject-hash";
const RUN_KEY = "a".repeat(64);

test("a run is claimed in one conditional statement that only an expired claim yields to", async () => {
  const claim = await claims.claimInFlightRun(SUBJECT, "comparison-review", RUN_KEY, 900);

  assert.equal(statements.length, 1, "no read-then-write: exactly one round trip");
  const [{ sql, values }] = statements;
  assert.match(sql, /INSERT INTO "ChatUsageBucket"/);
  assert.match(sql, /ON CONFLICT \("key", "period", "periodStart"\)/);
  assert.match(sql, /DO UPDATE SET/);
  // The takeover condition is part of the same statement: a live claim makes
  // the upsert return no row, an expired one is overwritten by the new holder.
  assert.match(
    sql,
    /WHERE "ChatUsageBucket"\."updatedAt" < NOW\(\) - \?::int \* INTERVAL '1 second'/
  );
  assert.match(sql, /"count" = EXCLUDED\."count"/);
  assert.match(sql, /RETURNING "count"/);
  // The TTL and the holder's token are bound parameters, never interpolated.
  assert.ok(values.includes(900));
  assert.ok(values.includes(claim.token));
  assert.ok(Number.isSafeInteger(claim.token) && claim.token >= 1 && claim.token < 2 ** 31);
  assert.ok(values.includes(claim.key));
  assert.ok(values.includes(claim.period));
});

test("a live claim refuses the second request with the guest route's duplicate code", async () => {
  nextRows = [[]];
  await assert.rejects(
    () => claims.claimInFlightRun(SUBJECT, "comparison-review", RUN_KEY, 900),
    (error: Error & { code?: string; status?: number }) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "DUPLICATE_REQUEST");
      return true;
    }
  );
});

test("release removes only the holder's own claim", async () => {
  const claim = await claims.claimInFlightRun(SUBJECT, "comparison-review", RUN_KEY, 900);
  await claims.releaseInFlightRun(claim);

  assert.equal(deletes.length, 1);
  const { where } = deletes[0];
  assert.equal(where.key, claim.key);
  assert.equal(where.period, claim.period);
  assert.equal(where.periodStart, claim.periodStart);
  // Keyed on the token: a holder that overran its TTL and was taken over
  // must not delete the new holder's claim.
  assert.equal(where.count, BigInt(claim.token));
});

test("two claims never share a token, so neither can release the other", async () => {
  const tokens = new Set<number>();
  for (let index = 0; index < 50; index += 1) {
    tokens.add((await claims.claimInFlightRun(SUBJECT, "comparison-review", RUN_KEY, 900)).token);
  }
  // Random int4 tokens: a collision in 50 draws is ~6e-7, and would only
  // weaken the overrun guard, never the duplicate refusal.
  assert.equal(tokens.size, 50);
});

test("the claim row is swept by account deletion and never mistaken for a time bucket", async () => {
  const claim = await claims.claimInFlightRun(SUBJECT, "comparison-review", RUN_KEY, 900);
  // lib/accountDeletion.ts deletes every usage row whose key starts with the
  // account's usage key.
  assert.ok(claim.key.startsWith(`${SUBJECT}:`));
  assert.ok(claim.key.includes(RUN_KEY), "the claim is per input, not per account");
  // lib/maintenance.ts deletes %minute%/%day% rows whose periodStart is past
  // and %month% rows after 120 days, by periodStart. This claim's periodStart
  // is fixed, so any of those names would delete a live claim; outside them a
  // row is swept only after 90 idle days.
  const maintenance = await readFile(resolve(ROOT, "lib/maintenance.ts"), "utf8");
  assert.match(maintenance, /"period" LIKE '%minute%'/);
  for (const fragment of ["minute", "day", "month"]) {
    assert.ok(!claim.period.includes(fragment), `period "${claim.period}" contains "${fragment}"`);
  }
  assert.notEqual(claim.period, "lock-15m");
});

test("the TTL outlasts the worst-case run of the default reviewer panel", async () => {
  // lib/comparisonReviewService.ts: every reviewer request is aborted at 45 s
  // and a non-timeout failure is retried once, so one candidate can take
  // 2 x 45 s. The sequential path can try all N candidates for the primary
  // review and the other N - 1 for the secondary.
  const service = await readFile(resolve(ROOT, "lib/comparisonReviewService.ts"), "utf8");
  assert.match(service, /AbortSignal\.timeout\(45_000\)/, "the per-request deadline changed; re-derive the claim TTL");
  assert.match(service, /attempt < 2;/, "the per-candidate retry count changed; re-derive the claim TTL");
  const perCandidateSeconds = 2 * 45;
  const panel = review.COMPARISON_REVIEW_DEFAULT_MODEL_IDS.length;
  const worstCaseSeconds = (2 * panel - 1) * perCandidateSeconds;
  assert.ok(
    inFlight.COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS >= worstCaseSeconds * 1.5,
    `TTL ${inFlight.COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS}s leaves too little margin over a ${worstCaseSeconds}s worst case`
  );
  // ...and a dead holder does not lock the review out for longer than this.
  assert.ok(inFlight.COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS <= 30 * 60);
});
