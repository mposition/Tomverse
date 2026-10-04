-- One account's verdict on one claim inside one AI Review.
--
-- docs/policy/ai-review-m5-quality-contract.md §9.
--
-- Purely additive: a new table, no existing column touched, nothing read or
-- written. Reversing it is DROP TABLE.
--
-- Why the item is identified by a derived id rather than a stored one: a
-- ComparisonReview's `result` JSON is validated on read against the schemas in
-- lib/comparisonReview.ts, so adding an `id` field to every claim would
-- invalidate every review ever cached. lib/comparisonReviewItemFeedback.ts
-- derives `section:ordinal:digest` from the result that is already there, and
-- a changed claim gets a new id rather than silently inheriting an old
-- verdict.
--
-- Why the unique index is the whole point: (review, user, item) is the
-- idempotency key. A double click updates one row rather than creating two,
-- changing a verdict is an UPDATE, and withdrawing one is a DELETE.
--
-- Guests are absent by construction, not by a check: a guest AI Review is
-- never persisted, so there is no ComparisonReview row for a guest verdict to
-- reference.
CREATE TABLE "ComparisonReviewItemFeedback" (
    "id" TEXT NOT NULL,
    "comparisonReviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reviewItemId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComparisonReviewItemFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComparisonReviewItemFeedback_comparisonReviewId_userId_revi_key"
    ON "ComparisonReviewItemFeedback"("comparisonReviewId", "userId", "reviewItemId");
CREATE INDEX "ComparisonReviewItemFeedback_userId_createdAt_idx"
    ON "ComparisonReviewItemFeedback"("userId", "createdAt");
CREATE INDEX "ComparisonReviewItemFeedback_verdict_createdAt_idx"
    ON "ComparisonReviewItemFeedback"("verdict", "createdAt");

-- Both cascades are deliberate and are the deletion path: the verdict is about
-- one review, and it is the user's own data, so it must not outlive either.
ALTER TABLE "ComparisonReviewItemFeedback"
    ADD CONSTRAINT "ComparisonReviewItemFeedback_comparisonReviewId_fkey"
    FOREIGN KEY ("comparisonReviewId") REFERENCES "ComparisonReview"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComparisonReviewItemFeedback"
    ADD CONSTRAINT "ComparisonReviewItemFeedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
