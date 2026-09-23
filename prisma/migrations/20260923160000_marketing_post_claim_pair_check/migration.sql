-- A claim token and its lease are set together or not at all.
--
-- Authority: the S2 plan's "S2c -- adapter contract and claim-only publisher".
-- `claimDueMarketingPost` writes both, and `releaseMarketingPostClaim` and a
-- requeue clear both; no writer in the store sets one without the other. This
-- makes that a property of the table rather than of the writers.
--
-- Why it matters enough to be a constraint. A row holding a token with no lease
-- is claimed by nobody and reclaimable by nobody: the claim path treats a row
-- as free when it has no token, and as abandoned when its lease has passed, and
-- `NULL <= now` is neither. Such a post would never go out and nothing would
-- say why. The store does not create that state today; the publisher that S2d2
-- adds will write these columns too, and this is where a mistake in it should
-- fail -- at the write, loudly -- rather than as a post that quietly stops.
--
-- No rows can violate it. Production has no MarketingPost table yet, and
-- staging held zero rows when it was last read, on 2026-09-23. If the
-- constraint does fail to add, some writer has created the very state it
-- forbids, and that is worth finding out at deploy time.

ALTER TABLE "MarketingPost"
    ADD CONSTRAINT "MarketingPost_claim_pair_check"
    CHECK (("claimToken" IS NULL) = ("leaseUntil" IS NULL));
