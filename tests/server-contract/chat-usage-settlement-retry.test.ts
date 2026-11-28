import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

/**
 * settleChatUsage after a transient database failure
 * (docs/policy/credit-and-cost-limits.md, "정산 실패와 재시도").
 *
 * One dropped connection used to end a Chat turn's settlement: the route
 * logged it, its memo kept anything else from settling, and the expiry sweep
 * later closed the reservation as a refund. The settlement transaction is now
 * tried again -- and these pin why that is safe: it settles only a row that is
 * still `reserved` under its lock, so a try whose COMMIT landed and whose
 * answer was lost is found by the next try and nothing moves twice.
 *
 * The database is a fake that scripts each transaction's fate; the
 * settlement code is the real lib/chatSecurity.ts.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";

type Step = "start_failure" | "commit_then_lost" | "fatal" | "run";

const RESERVATION_ID = "reservation-settlement-retry";
const world = {
  script: [] as Step[],
  status: "reserved",
  transactions: 0,
  /** Terminal writes that landed: the money moving. */
  terminalWrites: 0,
  reservationReads: 0,
};

const connectionClosed = () =>
  Object.assign(new Error("connection closed"), {
    name: "DriverAdapterError",
    cause: { kind: "ConnectionClosed" },
  });
const startFailure = () =>
  new Prisma.PrismaClientKnownRequestError("Unable to start a transaction in the given time.", {
    code: "P2028",
    clientVersion: "test",
  });

const tx = {
  $executeRaw: async () => 0,
  chatCreditReservation: {
    findUnique: async () => {
      world.reservationReads += 1;
      return {
        id: RESERVATION_ID,
        status: world.status,
        reservedCredits: 5,
        provider: "openai",
        modelId: "settlement-retry-model",
      };
    },
    update: async () => {
      world.terminalWrites += 1;
      throw new Error("a terminal row must never be settled again");
    },
  },
};

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
        world.transactions += 1;
        const step = world.script.shift() ?? "run";
        if (step === "start_failure") throw startFailure();
        if (step === "fatal") throw new Error("a statement this settlement does not recover from");
        if (step === "commit_then_lost") {
          // The settlement committed -- the row is terminal, the money moved
          // once -- and the connection dropped before COMMIT's answer arrived.
          world.status = "settled";
          world.terminalWrites += 1;
          throw connectionClosed();
        }
        return fn(tx);
      },
    },
  },
});

const { settleChatUsage } = require(resolve(ROOT, "lib/chatSecurity.ts")) as {
  settleChatUsage: (
    reservation: unknown,
    usage: Record<string, unknown>
  ) => Promise<{ applied: boolean; status: string; settledCredits: number | null }>;
};

const reservation = { reservationId: RESERVATION_ID, userId: "user-settlement-retry" };
const quietRetries = () => mock.method(console, "warn", () => {});

const reset = (script: Step[], status = "reserved") => {
  world.script = script;
  world.status = status;
  world.transactions = 0;
  world.terminalWrites = 0;
  world.reservationReads = 0;
};

test("a commit whose answer was lost is found by the retry and settles nothing twice", async () => {
  reset(["commit_then_lost"]);
  const warn = quietRetries();
  try {
    const result = await settleChatUsage(reservation, {
      inputTokens: 100,
      outputTokens: 50,
      outcome: "completed",
    });
    assert.equal(world.transactions, 2, "tried again after the dropped connection");
    assert.equal(world.terminalWrites, 1, "the money moved exactly once");
    assert.equal(result.applied, false);
    assert.equal(result.status, "settled");
    // Null, not 0: the earlier try charged; this one charged nothing more.
    assert.equal(result.settledCredits, null);
    const retryLine = JSON.parse(String(warn.mock.calls[0]?.arguments[0]));
    assert.equal(retryLine.event, "chat_usage_settlement_retry");
    assert.equal(retryLine.reservationId, RESERVATION_ID);
    assert.equal(retryLine.attempt, 1);
  } finally {
    warn.mock.restore();
  }
});

test("a transaction that never started is tried again", async () => {
  // Settled already by another path, so the second try's read ends it.
  reset(["start_failure"], "refunded");
  const warn = quietRetries();
  try {
    const result = await settleChatUsage(reservation, { outcome: "failed" });
    assert.equal(world.transactions, 2);
    assert.equal(world.reservationReads, 1, "the failed start never reached the row");
    assert.equal(result.applied, false);
    assert.equal(result.status, "refunded");
    assert.equal(world.terminalWrites, 0);
  } finally {
    warn.mock.restore();
  }
});

test("a failure that is not transient is not retried", async () => {
  reset(["fatal"]);
  await assert.rejects(
    settleChatUsage(reservation, { outcome: "completed" }),
    /does not recover/
  );
  assert.equal(world.transactions, 1);
});

test("two more tries at most, then the failure reaches the caller", async () => {
  reset(["start_failure", "start_failure", "start_failure"]);
  const warn = quietRetries();
  try {
    await assert.rejects(
      settleChatUsage(reservation, { outcome: "completed" }),
      (error: { code?: string }) => error.code === "P2028"
    );
    assert.equal(world.transactions, 3);
    assert.equal(world.reservationReads, 0);
  } finally {
    warn.mock.restore();
  }
});

test("the expiry sweep keeps an ordinary Chat turn's estimate on the provider side", () => {
  const { expiredChatReservationEstimate } = require(resolve(ROOT, "lib/chatSecurity.ts")) as {
    expiredChatReservationEstimate: (source: string, modelId: string) => { turnUsage: Record<string, unknown> } | null;
  };
  // No credits (a failed turn earns none), no token counts (so settlement
  // takes the reservation's own estimate), and searches kept at their
  // authorized ceiling because nobody counted them.
  const expected = { turnUsage: { outcome: "failed", usageFromProvider: false, searchQueriesObserved: false } };
  assert.deepEqual(expiredChatReservationEstimate("chat", "gpt-5-4-mini"), expected);
  // A model retired since the reservation was written is still an ordinary turn.
  assert.deepEqual(expiredChatReservationEstimate("chat", "a-model-nobody-knows-any-more"), expected);
  // Deep Research is decided by its own handoff; Review keeps its old refund.
  assert.equal(expiredChatReservationEstimate("chat", "perplexity/sonar-deep-research"), null);
  assert.equal(expiredChatReservationEstimate("comparison_review", "gpt-5-4-mini"), null);
});
