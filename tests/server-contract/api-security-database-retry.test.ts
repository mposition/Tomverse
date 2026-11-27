import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

/**
 * `consumeApiRateLimit` is the first step of hundreds of user routes. A database
 * that blinks inside its transaction used to leave as each route's generic 500.
 *
 * One retry absorbs the blink. A second failure becomes the shared 503 shape --
 * an `ApiSecurityError`, which every route already turns into a response with
 * `apiSecurityResponse` -- so the caller is told to come back rather than that
 * the server is broken. The limiter itself (a 429) is never retried.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";

type Attempt = "ok" | "limited" | { throws: unknown } | { failAtCommit: unknown };
const world = {
  script: [] as Attempt[],
  transactions: 0,
  /** Every INSERT ... ON CONFLICT the bucket writer issued, per attempt. */
  committedIncrements: 0,
  pendingIncrements: 0,
  rolledBack: 0,
};

const startFailure = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Transaction API error: Unable to start a transaction in the given time.",
    { code: "P2028", clientVersion: "test" }
  );

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        world.transactions += 1;
        const step = world.script.shift() ?? "ok";
        if (typeof step === "object" && "throws" in step) throw step.throws;
        world.pendingIncrements = 0;
        const tx = {
          // incrementBucket: `rows.length > 0` means the bucket accepted the unit.
          $queryRaw: async () => {
            world.pendingIncrements += 1;
            return step === "limited" ? [] : [{ count: 1 }];
          },
        };
        try {
          const result = await callback(tx);
          if (typeof step === "object" && "failAtCommit" in step) {
            // Everything the callback wrote is discarded with the transaction
            // (the catch below counts the rollback).
            throw step.failAtCommit;
          }
          world.committedIncrements += world.pendingIncrements;
          return result;
        } catch (error) {
          world.rolledBack += 1;
          throw error;
        }
      },
    },
  },
});

type ApiSecurityModule = typeof import("../../lib/apiSecurity.ts");
let loaded: ApiSecurityModule | null = null;
const security = async () =>
  (loaded ??= (await import(`${mod("lib/apiSecurity.ts")}?retry=cached`)) as ApiSecurityModule);

const request = () =>
  new Request("http://127.0.0.1:3100/api/x", { headers: { "x-forwarded-for": "203.0.113.9" } });
const call = async () =>
  (await security()).consumeApiRateLimit(request(), "user-1", "retry-test", {
    minute: 10,
    day: 100,
  });

const reset = (script: Attempt[]) => {
  world.script = script;
  world.transactions = 0;
  world.committedIncrements = 0;
  world.pendingIncrements = 0;
  world.rolledBack = 0;
};

test("a healthy database is one transaction, as before", async () => {
  reset(["ok"]);
  await call();
  assert.equal(world.transactions, 1);
});

test("one transient database error is absorbed by a single retry", async () => {
  reset([{ throws: startFailure() }, "ok"]);
  await call();
  assert.equal(world.transactions, 2);
});

test("a failed attempt counts nothing, so the retry cannot count the request twice", async () => {
  reset(["ok"]);
  await call();
  const onePass = world.committedIncrements;
  assert.ok(onePass >= 2, "a pass increments at least the user's minute and day buckets");

  // The first attempt writes every bucket and then loses its connection before
  // the commit: its increments leave with the rollback, the retry's stay.
  const connectionClosed = Object.assign(new Error("connection closed"), {
    name: "DriverAdapterError",
    cause: { kind: "ConnectionClosed" },
  });
  reset([{ failAtCommit: connectionClosed }, "ok"]);
  await call();
  assert.equal(world.transactions, 2);
  assert.equal(world.rolledBack, 1);
  assert.equal(world.committedIncrements, onePass, "one pass was kept, not two");
});

test("a second transient error is answered 503 with Retry-After, not a generic 500", async () => {
  reset([{ throws: startFailure() }, { throws: startFailure() }]);
  const { ApiSecurityError, apiSecurityResponse } = await security();
  await assert.rejects(call(), (error: unknown) => {
    assert.ok(error instanceof ApiSecurityError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "DATABASE_TEMPORARILY_UNAVAILABLE");
    assert.equal(error.retryAfter, 2);
    return true;
  });
  assert.equal(world.transactions, 2, "exactly one retry");

  reset([{ throws: startFailure() }, { throws: startFailure() }]);
  const error = await call().catch((caught: unknown) => caught);
  const response = apiSecurityResponse(error)!;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "2");
  assert.deepEqual(await response.json(), {
    error: "The service is temporarily unavailable. Please try again shortly.",
    code: "DATABASE_TEMPORARILY_UNAVAILABLE",
  });
});

test("an error that is not a transient database error is not retried", async () => {
  const bug = new Error("not a database fault");
  reset([{ throws: bug }, "ok"]);
  await assert.rejects(call(), bug);
  assert.equal(world.transactions, 1);

  // An expired transaction is a write whose outcome is unknown.
  const expired = new Prisma.PrismaClientKnownRequestError(
    "Transaction API error: A commit cannot be executed on an expired transaction.",
    { code: "P2028", clientVersion: "test" }
  );
  reset([{ throws: expired }, "ok"]);
  await assert.rejects(call(), expired);
  assert.equal(world.transactions, 1);
});

test("the limiter's own 429 is never retried", async () => {
  reset(["limited", "ok"]);
  const { ApiSecurityError } = await security();
  await assert.rejects(call(), (error: unknown) => {
    assert.ok(error instanceof ApiSecurityError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "API_RATE_LIMITED");
    return true;
  });
  assert.equal(world.transactions, 1);
});
