-- The Codex public-source pin is an immutable part of candidate admission.
-- Older provider-free synthetic cycles remain nullable and cannot pass the
-- AMUX source readback gate without a newly registered pinned candidate.
ALTER TABLE "ChatUnifiedOptimizerCandidate"
  ADD COLUMN "sourceRepositoryId" BIGINT,
  ADD COLUMN "sourceBlobSha" TEXT,
  ADD COLUMN "sourceSha256" TEXT;

ALTER TABLE "ChatUnifiedOptimizerCandidate"
  ADD CONSTRAINT "ChatUnifiedOptimizerCandidate_sourcePin_complete" CHECK (
    ("sourceRepositoryId" IS NULL AND "sourceBlobSha" IS NULL AND
      "sourceSha256" IS NULL) OR
    ("sourceRepositoryId" IS NOT NULL AND "sourceRepositoryId" > 0 AND
      "sourceBlobSha" IS NOT NULL AND "sourceSha256" IS NOT NULL AND
      "sourceBlobSha" ~ '^[0-9a-f]{40}$' AND
      "sourceSha256" ~ '^[0-9a-f]{64}$')
  );
