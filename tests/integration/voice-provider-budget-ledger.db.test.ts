import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { reserveVoiceProviderSeconds } from "@/lib/voiceProviderBudgetLedger";
import {
  secondsUntilVoiceBudgetDayReset,
  secondsUntilVoiceBudgetMonthReset,
  VOICE_PROVIDER_BUDGET_PERIODS,
} from "@/lib/voiceProviderBudget";

/**
 * What the deployment's audio budget tells a refused caller to do next.
 *
 * Contract: docs/policy/voice-input.md §6.1-4.
 *
 * The boundary arithmetic is unit-tested in tests/voiceProviderBudget.test.mjs.
 * What only a database can show is that the *ledger* quotes the right one --
 * the day and month buckets are separate rows refused at separate moments, and
 * a unit test of the helpers cannot catch the two being wired the wrong way
 * round. That is exactly the defect this suite was written for: a monthly
 * refusal answered with tomorrow's figure, which sends the caller back into
 * the same refusal every day until the 1st.
 */

// Mid-month and mid-year on purpose: the two boundaries are far apart here, so
// swapping them is a visible difference rather than a rounding one.
const NOW = new Date("2026-09-08T00:00:00.000Z");

const env = (day: number, month: number) => ({
  ...process.env,
  VOICE_PROVIDER_SECONDS_PER_DAY: String(day),
  VOICE_PROVIDER_SECONDS_PER_MONTH: String(month),
});

const clearBuckets = async () => {
  await prisma.chatUsageBucket.deleteMany({
    where: {
      period: {
        in: [
          VOICE_PROVIDER_BUDGET_PERIODS.day,
          VOICE_PROVIDER_BUDGET_PERIODS.month,
        ],
      },
    },
  });
};

const refusalFrom = async (input: {
  seconds: number;
  env: Record<string, string | undefined>;
}) => {
  try {
    await reserveVoiceProviderSeconds({ ...input, now: NOW });
  } catch (error) {
    return error as { status: number; code: string; retryAfter?: number };
  }
  return null;
};

const bucketCount = async (period: string) => {
  const rows = await prisma.chatUsageBucket.findMany({ where: { period } });
  // `count` is a BigInt column; the assertions compare against plain numbers.
  return rows.reduce((total, row) => total + Number(row.count), 0);
};

beforeEach(clearBuckets);
after(async () => {
  await clearBuckets();
  await prisma.$disconnect();
});

test("a daily refusal is told to come back tomorrow", async () => {
  // Day is the binding bucket: 100 booked against a limit of 100.
  await reserveVoiceProviderSeconds({
    seconds: 100,
    env: env(100, 100_000),
    now: NOW,
  });

  const refusal = await refusalFrom({ seconds: 10, env: env(100, 100_000) });

  assert.ok(refusal, "the second reservation should have been refused");
  assert.equal(refusal.status, 429);
  assert.equal(refusal.retryAfter, secondsUntilVoiceBudgetDayReset(NOW));
});

test("a monthly refusal is told to come back on the 1st", async () => {
  // The defect. Month binds while the day still has room, so the two answers
  // differ and only one of them is true.
  await reserveVoiceProviderSeconds({
    seconds: 100,
    env: env(100_000, 100),
    now: NOW,
  });

  const refusal = await refusalFrom({ seconds: 10, env: env(100_000, 100) });

  assert.ok(refusal, "the second reservation should have been refused");
  assert.equal(refusal.status, 429);
  assert.equal(refusal.retryAfter, secondsUntilVoiceBudgetMonthReset(NOW));
  // Stated as an inequality too: this is the assertion that fails if the two
  // helpers are ever swapped back.
  assert.ok(
    refusal.retryAfter! > secondsUntilVoiceBudgetDayReset(NOW),
    "a monthly refusal that lifts tomorrow is the bug"
  );
});

test("a monthly refusal gives the day's booking back", async () => {
  // The day is booked first and the month refuses second. Without the
  // compensating release, a month-capped deployment burns its daily budget on
  // requests that never ran.
  await reserveVoiceProviderSeconds({
    seconds: 100,
    env: env(100_000, 100),
    now: NOW,
  });
  assert.equal(await bucketCount(VOICE_PROVIDER_BUDGET_PERIODS.day), 100);

  await refusalFrom({ seconds: 10, env: env(100_000, 100) });

  assert.equal(
    await bucketCount(VOICE_PROVIDER_BUDGET_PERIODS.day),
    100,
    "the refused request must not have left its day booking behind"
  );
});

test("a clip larger than the whole month is told the month, not tomorrow", async () => {
  // The pre-check path rather than the booking path: nothing is booked, and
  // the hint still has to name the bucket that would have refused.
  const refusal = await refusalFrom({ seconds: 500, env: env(100_000, 100) });

  assert.ok(refusal);
  assert.equal(refusal.retryAfter, secondsUntilVoiceBudgetMonthReset(NOW));
});

test("a clip larger than the whole day is told tomorrow", async () => {
  const refusal = await refusalFrom({ seconds: 500, env: env(100, 100_000) });

  assert.ok(refusal);
  assert.equal(refusal.retryAfter, secondsUntilVoiceBudgetDayReset(NOW));
});
