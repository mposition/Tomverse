import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  comparisonReviewItems,
  summariseItemFeedback,
} from "@/lib/comparisonReviewItemFeedback";

// What the unit tests cannot establish: that the unique index really is the
// idempotency key, that a verdict is scoped to one person, and that both
// cascades are the deletion path the registry claims they are.

const REVIEW_RESULT = {
  primary: {
    reviewerModelId: "mistral-medium-3-1",
    result: {
      consensus: [{ text: "Both answers agree on the length.", citations: [], verified: true }],
      differences: [],
      contradictions: [
        { text: "They disagree on the opening year.", citations: [], verified: false },
      ],
      missingPoints: ["B omits the rollback path."],
      verificationNeeded: [],
      modelAssessments: [
        { responseId: "A", strengths: [], cautions: [] },
        { responseId: "B", strengths: [], cautions: [] },
      ],
      synthesis: "",
      limitations: [],
      confidence: "medium",
      groundingStats: { totalCitations: 0, verifiedCitations: 0 },
    },
  },
  secondary: null,
  agreement: null,
};

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "ComparisonReviewItemFeedback", "ComparisonReview", "Conversation", "User" RESTART IDENTITY CASCADE`
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seed = async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, plan: "Pro" },
  });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, title: "t" },
  });
  const review = await prisma.comparisonReview.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      promptMessageId: randomUUID(),
      assistantMessageIds: [randomUUID(), randomUUID()],
      reviewerModelId: "mistral-medium-3-1",
      reviewMode: "balanced",
      promptVersion: "comparison-review-v3",
      result: REVIEW_RESULT,
      usageCredits: 8,
      inputHash: randomUUID(),
    },
  });
  return { user, conversation, review };
};

const itemId = (section: string, ordinal = 0) =>
  comparisonReviewItems(REVIEW_RESULT.primary.result).find(
    (item) => item.section === section && item.ordinal === ordinal
  )!.id;

const put = (
  reviewId: string,
  userId: string,
  reviewItemId: string,
  verdict: string
) =>
  prisma.comparisonReviewItemFeedback.upsert({
    where: {
      comparisonReviewId_userId_reviewItemId: {
        comparisonReviewId: reviewId,
        userId,
        reviewItemId,
      },
    },
    create: {
      comparisonReviewId: reviewId,
      userId,
      reviewItemId,
      section: reviewItemId.split(":")[1],
      verdict,
    },
    update: { verdict },
  });

test("submitting the same verdict twice leaves one row", async () => {
  const { user, review } = await seed();
  const item = itemId("contradictions");
  await put(review.id, user.id, item, "incorrect");
  await put(review.id, user.id, item, "incorrect");
  const rows = await prisma.comparisonReviewItemFeedback.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "incorrect");
  assert.equal(rows[0].section, "contradictions");
});

test("changing a verdict updates the row rather than adding one", async () => {
  const { user, review } = await seed();
  const item = itemId("contradictions");
  await put(review.id, user.id, item, "incorrect");
  await put(review.id, user.id, item, "unclear");
  const rows = await prisma.comparisonReviewItemFeedback.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "unclear");
});

test("withdrawing is idempotent: deleting twice is not an error", async () => {
  const { user, review } = await seed();
  const item = itemId("missingPoints");
  await put(review.id, user.id, item, "helpful");
  const where = {
    comparisonReviewId: review.id,
    userId: user.id,
    reviewItemId: item,
  };
  const first = await prisma.comparisonReviewItemFeedback.deleteMany({ where });
  const second = await prisma.comparisonReviewItemFeedback.deleteMany({ where });
  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
  assert.equal(await prisma.comparisonReviewItemFeedback.count(), 0);
});

test("two people may hold different verdicts on the same item", async () => {
  const { user, review } = await seed();
  const other = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, plan: "Pro" },
  });
  const item = itemId("consensus");
  await put(review.id, user.id, item, "helpful");
  await put(review.id, other.id, item, "incorrect");
  const rows = await prisma.comparisonReviewItemFeedback.findMany({
    orderBy: { verdict: "asc" },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.verdict), ["helpful", "incorrect"]);
});

test("one person may hold a verdict on each item of one review", async () => {
  const { user, review } = await seed();
  for (const section of ["consensus", "contradictions", "missingPoints"]) {
    await put(review.id, user.id, itemId(section), "helpful");
  }
  assert.equal(await prisma.comparisonReviewItemFeedback.count(), 3);
});

test("deleting the review takes its verdicts with it", async () => {
  const { user, review } = await seed();
  await put(review.id, user.id, itemId("consensus"), "helpful");
  await prisma.comparisonReview.delete({ where: { id: review.id } });
  assert.equal(await prisma.comparisonReviewItemFeedback.count(), 0);
});

test("deleting the account takes its verdicts with it", async () => {
  const { user, review } = await seed();
  await put(review.id, user.id, itemId("consensus"), "helpful");
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.comparisonReviewItemFeedback.count(), 0);
});

test("the aggregate reports counts and refuses a rate on too few rows", async () => {
  const { user, review } = await seed();
  await put(review.id, user.id, itemId("contradictions"), "incorrect");
  const rows = await prisma.comparisonReviewItemFeedback.findMany({
    select: { verdict: true, section: true },
  });
  const summary = summariseItemFeedback(rows);
  assert.equal(summary.total, 1);
  assert.equal(summary.byVerdict.incorrect, 1);
  assert.equal(summary.negativeRate, null);
});
