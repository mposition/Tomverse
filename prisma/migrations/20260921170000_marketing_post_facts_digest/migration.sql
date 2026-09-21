-- A scope digest can be recomputed from the post columns, but it deliberately
-- does not say what the resolver answered. Preserve the Guard's full digest so
-- two decisions with the same ids and different answers are different records.
ALTER TABLE "MarketingPost"
    ADD COLUMN "factsDigest" TEXT NOT NULL,
    ADD CONSTRAINT "MarketingPost_facts_digest_format"
        CHECK ("factsDigest" ~ '^[a-f0-9]{64}$');
