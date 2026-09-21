-- A scope digest can be recomputed from the post columns, but it deliberately
-- does not say what the resolver answered. Preserve the Guard's full digest so
-- two decisions with the same ids and different answers are different records.
--
-- Expand only. Existing rows predate the stored full digest and have no value
-- that can be reconstructed from their columns. The updated writer always
-- provides it; rows created before or during rollout may remain NULL. A later
-- migration may make the column NOT NULL after staging and production row
-- evidence has been recorded for that transition.
ALTER TABLE "MarketingPost"
    ADD COLUMN "factsDigest" TEXT,
    ADD CONSTRAINT "MarketingPost_facts_digest_format"
        CHECK (
            "factsDigest" IS NULL
            OR "factsDigest" ~ '^[a-f0-9]{64}$'
        ) NOT VALID;
