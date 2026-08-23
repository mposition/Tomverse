-- Importing an external assistant package: the staging that makes it reviewable.
--
-- Policy: docs/policy/assistant-package-import.md §5, §6, §10.
--
-- Two tables and two columns, and each exists because of a specific way the
-- import could otherwise go wrong.
--
--   * `AssistantProfileImport` is the attempt itself. It is the first thing
--     written -- steps 1 to 6 of the wizard happen entirely in the browser --
--     and it outlives the import, because a published profile has to be able
--     to say where it came from. `mode` is not a label: it is the branch the
--     cancellation and expiry sweeps take, and `create` deletes a profile
--     while `merge` must never do so. Hence the CHECK, and hence the
--     fail-closed preconditions the sweep re-tests before deleting anything.
--
--   * `AssistantKnowledgeUploadReservation` is proof that this server issued
--     an upload key. `knowledgeKey()` is a random UUID, so a key by itself
--     says nothing about who asked for it -- and without a record, finalize
--     would have to decide from the client's own claim whether a stored object
--     is safe to delete. It also closes the hole the isolation column below
--     would otherwise have: the ordinary finalize path, which knows nothing
--     about imports, would turn an import's key into an ordinary file.
--
--   * `AssistantKnowledgeFile.importId` is that isolation. A file staged for
--     an import under review is invisible to the ordinary knowledge list and
--     to the ordinary manifest resolver, so another tab cannot publish it.
--     Publishing the import sets the column to NULL, and that is promotion.
--
--   * `AssistantKnowledgeFile.extractedBytes` fixes a unit mismatch that
--     predates this feature. Incoming text is judged in UTF-8 bytes, and the
--     running account total was summed from `extractedCharacters` because the
--     byte count was computed and thrown away -- so a Korean document counted
--     about a third of what it costs. The extractor now stores what it already
--     measured.
--
-- CHECK constraints:
--
--   mode                create | merge. The sweep's branch.
--   status              staging | published. The expiry sweep's filter.
--   state               pending | finalizing. The reservation's claim.
--   claim agreement     the three claim columns move together, or not at all.
--   extractedBytes      non-negative. New column, so immediately valid.
--   extractedCharacters non-negative, NOT VALID -- see the note at the end.
--
-- Backward compatible: every existing knowledge file gets NULL in both new
-- columns, which is exactly what "an ordinary file nobody has re-measured"
-- means, and no existing query changes its answer.

CREATE TABLE IF NOT EXISTS "AssistantProfileImport" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "expectedTargetRevision" INTEGER,
  "expectedTargetIdentityDigest" TEXT,
  "status" TEXT NOT NULL DEFAULT 'staging',
  "stagingManifest" JSONB,
  "candidateDigest" TEXT,
  "approvedDigest" TEXT,
  "digestVersion" INTEGER,
  "userApprovedAt" TIMESTAMP(3),
  "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validatorVersion" TEXT NOT NULL,
  "ingestPath" TEXT NOT NULL,
  "declaredSourceKind" TEXT,
  "declaredSourceName" TEXT,
  "declaredSourceUrl" TEXT,
  "declaredPreviousProvenance" JSONB,
  "versionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUserActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idleExpiresAt" TIMESTAMP(3) NOT NULL,
  "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssistantProfileImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantProfileImport_userId_createdAt_idx"
  ON "AssistantProfileImport" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantProfileImport_profileId_createdAt_idx"
  ON "AssistantProfileImport" ("profileId", "createdAt");
-- The two expiry sweeps read exactly these pairs. Separate indexes because the
-- idle clock and the absolute clock are separate questions: an import somebody
-- is still working on is not expired by the first and eventually is by the
-- second.
CREATE INDEX IF NOT EXISTS "AssistantProfileImport_status_idleExpiresAt_idx"
  ON "AssistantProfileImport" ("status", "idleExpiresAt");
CREATE INDEX IF NOT EXISTS "AssistantProfileImport_status_absoluteExpiresAt_idx"
  ON "AssistantProfileImport" ("status", "absoluteExpiresAt");

ALTER TABLE "AssistantProfileImport"
  DROP CONSTRAINT IF EXISTS "AssistantProfileImport_mode_check";
ALTER TABLE "AssistantProfileImport"
  ADD CONSTRAINT "AssistantProfileImport_mode_check"
  CHECK ("mode" IN ('create', 'merge'));

ALTER TABLE "AssistantProfileImport"
  DROP CONSTRAINT IF EXISTS "AssistantProfileImport_status_check";
ALTER TABLE "AssistantProfileImport"
  ADD CONSTRAINT "AssistantProfileImport_status_check"
  CHECK ("status" IN ('staging', 'published'));

ALTER TABLE "AssistantProfileImport"
  ADD CONSTRAINT "AssistantProfileImport_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantProfileImport"
  ADD CONSTRAINT "AssistantProfileImport_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "AssistantProfile" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL rather than CASCADE: if the version goes by any route, the fact
-- that an import happened still has to be true. Cascading would delete the
-- provenance along with the thing it explains.
ALTER TABLE "AssistantProfileImport"
  ADD CONSTRAINT "AssistantProfileImport_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "AssistantProfileVersion" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AssistantKnowledgeUploadReservation" (
  "r2Key" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "claimToken" TEXT,
  "finalizingStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssistantKnowledgeUploadReservation_pkey" PRIMARY KEY ("r2Key")
);

CREATE INDEX IF NOT EXISTS "AssistantKnowledgeUploadReservation_importId_idx"
  ON "AssistantKnowledgeUploadReservation" ("importId");
CREATE INDEX IF NOT EXISTS "AssistantKnowledgeUploadReservation_userId_createdAt_idx"
  ON "AssistantKnowledgeUploadReservation" ("userId", "createdAt");
-- The stale-claim sweep reads exactly this pair.
CREATE INDEX IF NOT EXISTS "AssistantKnowledgeUploadReservation_state_finalizingStartedAt_idx"
  ON "AssistantKnowledgeUploadReservation" ("state", "finalizingStartedAt");

ALTER TABLE "AssistantKnowledgeUploadReservation"
  DROP CONSTRAINT IF EXISTS "AssistantKnowledgeUploadReservation_state_check";
ALTER TABLE "AssistantKnowledgeUploadReservation"
  ADD CONSTRAINT "AssistantKnowledgeUploadReservation_state_check"
  CHECK ("state" IN ('pending', 'finalizing'));

-- The three claim columns are one fact and have to move together. A row
-- holding a token while pending claims a claimant nobody took; a row
-- finalizing without a timestamp is one the stale sweep passes over forever.
ALTER TABLE "AssistantKnowledgeUploadReservation"
  DROP CONSTRAINT IF EXISTS "AssistantKnowledgeUploadReservation_claim_agreement_check";
ALTER TABLE "AssistantKnowledgeUploadReservation"
  ADD CONSTRAINT "AssistantKnowledgeUploadReservation_claim_agreement_check"
  CHECK (
    ("state" = 'pending' AND "claimToken" IS NULL AND "finalizingStartedAt" IS NULL)
    OR
    ("state" = 'finalizing' AND "claimToken" IS NOT NULL AND "finalizingStartedAt" IS NOT NULL)
  );

ALTER TABLE "AssistantKnowledgeUploadReservation"
  ADD CONSTRAINT "AssistantKnowledgeUploadReservation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantKnowledgeUploadReservation"
  ADD CONSTRAINT "AssistantKnowledgeUploadReservation_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "AssistantProfileImport" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantKnowledgeFile"
  ADD COLUMN IF NOT EXISTS "extractedBytes" INTEGER;
ALTER TABLE "AssistantKnowledgeFile"
  ADD COLUMN IF NOT EXISTS "importId" TEXT;

CREATE INDEX IF NOT EXISTS "AssistantKnowledgeFile_importId_idx"
  ON "AssistantKnowledgeFile" ("importId");

-- CASCADE rather than RESTRICT. `User` cascades into both
-- `AssistantProfileImport` and this table with no ordering between them, so a
-- restricting edge would abort account deletion the moment the import row went
-- first. The R2 tombstones are the application's job on the cancel and expiry
-- paths; this is the backstop for the rows.
ALTER TABLE "AssistantKnowledgeFile"
  ADD CONSTRAINT "AssistantKnowledgeFile_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "AssistantProfileImport" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A new column: every existing row is NULL, so this is valid the moment it
-- exists and there is nothing to survey.
ALTER TABLE "AssistantKnowledgeFile"
  DROP CONSTRAINT IF EXISTS "AssistantKnowledgeFile_extractedBytes_non_negative_check";
ALTER TABLE "AssistantKnowledgeFile"
  ADD CONSTRAINT "AssistantKnowledgeFile_extractedBytes_non_negative_check"
  CHECK ("extractedBytes" IS NULL OR "extractedBytes" >= 0);

-- ## Why the next one is NOT VALID
--
-- `extractedCharacters` is an existing column with existing rows nobody has
-- surveyed. It has been close to a display value until now; this change makes
-- it a quota input, because a row with no `extractedBytes` is counted by its
-- character count instead. A negative value there stops being cosmetic and
-- starts granting allowance.
--
-- NOT VALID enforces it on every INSERT and UPDATE from here on -- which is
-- the coverage that matters, since the rows at risk are the ones not yet
-- written -- while skipping the full-table scan, and, more to the point,
-- while not being able to fail this deploy on historical data.
--
-- Validation is a separate migration, after the survey. The same three steps
-- `CreditLot` used:
--
--   1. this migration deploys (safe against any existing data);
--   2. `npm run report:assistant-knowledge-invariants` runs against
--      production and reports every violating row, if any;
--   3. once that reads zero, a follow-up migration runs
--      `ALTER TABLE "AssistantKnowledgeFile" VALIDATE CONSTRAINT ...`.
--
-- Do NOT validate by hand in production between (1) and (3).
-- `scripts/compare-schema-to-migrations.mjs` compares
-- `pg_get_constraintdef()`, whose output carries the `NOT VALID` suffix, so a
-- hand-validated production reads as schema drift for as long as the follow-up
-- migration is missing.
ALTER TABLE "AssistantKnowledgeFile"
  DROP CONSTRAINT IF EXISTS "AssistantKnowledgeFile_extractedCharacters_non_negative_check";
ALTER TABLE "AssistantKnowledgeFile"
  ADD CONSTRAINT "AssistantKnowledgeFile_extractedCharacters_non_negative_check"
  CHECK ("extractedCharacters" IS NULL OR "extractedCharacters" >= 0)
  NOT VALID;
