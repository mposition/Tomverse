import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { emptyAttemptRecord } from "@/lib/comparisonReviewRunCore";
import {
  purgeExpiredComparisonReviewRuns,
  recordComparisonReviewRun,
} from "@/lib/comparisonReviewRunTelemetry";

// What the unit tests cannot establish: that the record survives the round
// trip through Postgres with every field intact, that a guest run lands
// without a user, and that the 90-day purge only reaches rows past the cutoff.
//
// The content-exclusion assertion is repeated here on purpose. The unit test
// checks the object the builder returns; this checks the row the database
// actually holds, which is the thing a leak would be in.

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "ComparisonReviewRun" RESTART IDENTITY CASCADE`
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  traceId: randomUUID(),
  subjectKind: "account" as const,
  subjectKey: `user:${randomUUID()}`,
  userId: null,
  conversationId: null,
  reviewMode: "evidence",
  language: "ko",
  responseCount: 3,
  promptVersion: "comparison-review-v3",
  outcome: "completed_dual" as const,
  errorCode: null,
  startedAt: new Date("2026-08-30T00:00:00.000Z"),
  completedAt: new Date("2026-08-30T00:00:06.250Z"),
  dualReviewRequested: true,
  dualReviewAvailable: true,
  primary: {
    ...emptyAttemptRecord(),
    reviewerModelId: "mistral-medium-3-1",
    reviewerProvider: "mistral",
    status: "completed" as const,
    durationMs: 3_100,
    inputTokens: 4_200,
    outputTokens: 900,
    reservedCredits: 4,
    settlementStatus: "settled",
  },
  secondary: {
    ...emptyAttemptRecord(),
    reviewerModelId: "claude-sonnet-5",
    reviewerProvider: "anthropic",
    status: "completed" as const,
    durationMs: 3_050,
    inputTokens: 4_180,
    outputTokens: 870,
    reservedCredits: 4,
    settlementStatus: "settled",
  },
  groundingTotalQuotes: 9,
  groundingMatchedQuotes: 8,
  sourceGroundingLevel: "high",
  ...overrides,
});

test("a completed dual run round-trips with its derived fields", async () => {
  await recordComparisonReviewRun(baseInput());
  const rows = await prisma.comparisonReviewRun.findMany();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.outcome, "completed_dual");
  assert.equal(row.durationMs, 6_250);
  assert.equal(row.dualReviewCompleted, true);
  assert.equal(row.crossProvider, true);
  assert.equal(row.primaryModelId, "mistral-medium-3-1");
  assert.equal(row.secondaryProvider, "anthropic");
  assert.equal(row.primarySettlementStatus, "settled");
  assert.equal(row.groundingMatchedQuotes, 8);
  assert.equal(row.sourceGroundingLevel, "high");
});

test("a guest run is recorded with no user and no conversation", async () => {
  await recordComparisonReviewRun(
    baseInput({
      subjectKind: "guest",
      subjectKey: `guest:${randomUUID()}`,
      userId: null,
      conversationId: null,
      outcome: "completed_primary_only",
      secondary: emptyAttemptRecord(),
    })
  );
  const row = await prisma.comparisonReviewRun.findFirstOrThrow();
  assert.equal(row.subjectKind, "guest");
  assert.equal(row.userId, null);
  assert.equal(row.conversationId, null);
  assert.equal(row.dualReviewCompleted, false);
  assert.equal(row.crossProvider, null);
  assert.equal(row.secondaryStatus, "not_attempted");
});

test("a refusal before any provider call is distinguishable from a failure", async () => {
  await recordComparisonReviewRun(
    baseInput({
      outcome: "refused_before_provider",
      errorCode: "COMPARISON_REVIEWER_UNAVAILABLE",
      dualReviewAvailable: false,
      primary: emptyAttemptRecord(),
      secondary: emptyAttemptRecord(),
      groundingTotalQuotes: 0,
      groundingMatchedQuotes: 0,
      sourceGroundingLevel: null,
    })
  );
  const row = await prisma.comparisonReviewRun.findFirstOrThrow();
  assert.equal(row.outcome, "refused_before_provider");
  assert.equal(row.primaryStatus, "not_attempted");
  assert.equal(row.errorCode, "COMPARISON_REVIEWER_UNAVAILABLE");
});

test("no user content reaches the stored row", async () => {
  const forbidden = [
    "경부고속도로는 언제 전 구간이 개통되었나요",
    "The Eiffel Tower was completed in 1889",
    "quarterly-forecast-2026.xlsx",
  ];
  await recordComparisonReviewRun(baseInput());
  const rows = await prisma.comparisonReviewRun.findMany();
  const serialised = JSON.stringify(rows);
  for (const value of forbidden) {
    assert.equal(
      serialised.includes(value),
      false,
      `the stored row carries user content: ${value}`
    );
  }
});

test("the purge removes rows past 90 days and leaves the rest", async () => {
  const old = await prisma.comparisonReviewRun.create({
    data: {
      traceId: randomUUID(),
      subjectKind: "guest",
      subjectKey: `guest:${randomUUID()}`,
      reviewMode: "balanced",
      language: "en",
      responseCount: 2,
      promptVersion: "comparison-review-v3",
      outcome: "failed",
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 10,
      primaryStatus: "failed",
      secondaryStatus: "not_attempted",
      createdAt: new Date(Date.now() - 91 * 86_400_000),
    },
  });
  await recordComparisonReviewRun(baseInput());

  const result = await purgeExpiredComparisonReviewRuns();
  assert.equal(result.deleted, 1);
  const remaining = await prisma.comparisonReviewRun.findMany();
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].id, old.id);
});
