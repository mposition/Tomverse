-- Owner decision 2026-11-18 (docs/policy/amux-v22-result-transfer.md): a v22
-- run's result, patch and changed-path list carry no size bound of ours. They
-- reach the app in fixed-size chunks, held sealed in two staging tables until
-- the commit that records them, and the changed-path list is stored as its own
-- sealed body that settlement names by digest instead of a 9 MiB request.
--
-- 1. The result and patch digest checks keep every clause but the upper bound
--    on "byteLength" (32 MiB and 4 MiB): a byte length only has to be positive.
--    Rollback: add the bounds again only while no row is over them.
-- 2. The content key retirement ledger admits the new purpose
--    task_changed_paths.
-- 3. AmuxV22TransferPart and AmuxV22TransferChunk: staging. A chunk is at most
--    what one request carries (4 MiB), not a bound on the content; its
--    ciphertext is stored uncompressed out of line (it is random bytes).
-- 4. AmuxV22TaskChangedPaths: one sealed list per attempt, immutable but for
--    the retention purge clearing its body once, as AmuxV22TaskResult.
BEGIN;

ALTER TABLE "AmuxV22TaskResult"
  DROP CONSTRAINT "AmuxV22TaskResult_digest_check",
  ADD CONSTRAINT "AmuxV22TaskResult_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "sourceSha256" ~ '^[0-9a-f]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "byteLength" >= 1
  );

ALTER TABLE "AmuxV22TaskPatch"
  DROP CONSTRAINT "AmuxV22TaskPatch_digest_check",
  ADD CONSTRAINT "AmuxV22TaskPatch_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "patchSha256" ~ '^[0-9a-f]{64}$' AND
    "baseSha" ~ '^[0-9a-f]{40}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "byteLength" >= 1
  );

ALTER TABLE "AmuxIdeaContentKeyRetirement"
  DROP CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check",
  ADD CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check"
    CHECK ("purpose" IN ('idea_raw', 'transfer_payload', 'analysis_freeform',
      'analysis_draft', 'task_result', 'task_patch',
      'repository_read_manifest', 'analysis_result', 'review_findings',
      'task_changed_paths'));

CREATE TABLE "AmuxV22TransferPart" (
  "attemptId" TEXT NOT NULL,
  "part" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "worker" TEXT NOT NULL,
  "totalBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "baseSha" TEXT,
  "pathCount" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxV22TransferPart_pkey" PRIMARY KEY ("attemptId", "part"),
  CONSTRAINT "AmuxV22TransferPart_part_check"
    CHECK ("part" IN ('result', 'patch', 'changed_paths')),
  CONSTRAINT "AmuxV22TransferPart_check" CHECK (
    "totalBytes" >= 1 AND "sha256" ~ '^[0-9a-f]{64}$' AND
    ("part" = 'patch') = ("baseSha" IS NOT NULL) AND
    ("baseSha" IS NULL OR "baseSha" ~ '^[0-9a-f]{40}$') AND
    ("part" = 'changed_paths') = ("pathCount" IS NOT NULL) AND
    ("pathCount" IS NULL OR "pathCount" >= 1)
  )
);

CREATE TABLE "AmuxV22TransferChunk" (
  "attemptId" TEXT NOT NULL,
  "part" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "keyId" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxV22TransferChunk_pkey" PRIMARY KEY ("attemptId", "part", "index"),
  CONSTRAINT "AmuxV22TransferChunk_check" CHECK (
    "index" >= 0 AND "byteLength" BETWEEN 1 AND 4194304 AND
    "keyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND "keyVersion" > 0 AND
    "digest" ~ '^[0-9a-f]{64}$' AND "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$'
  )
);

ALTER TABLE "AmuxV22TransferChunk" ALTER COLUMN "ciphertext" SET STORAGE EXTERNAL;

CREATE TABLE "AmuxV22TaskChangedPaths" (
  "attemptId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "ciphertext" BYTEA,
  "keyId" TEXT,
  "keyVersion" INTEGER,
  "digest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "pathsSha256" TEXT NOT NULL,
  "pathCount" INTEGER NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bodyPurgedAt" TIMESTAMP(3),
  CONSTRAINT "AmuxV22TaskChangedPaths_pkey" PRIMARY KEY ("attemptId"),
  CONSTRAINT "AmuxV22TaskChangedPaths_body_check" CHECK (
    ("ciphertext" IS NOT NULL AND "keyId" IS NOT NULL AND
      "keyVersion" > 0 AND "bodyPurgedAt" IS NULL) OR
    ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL)
  ),
  CONSTRAINT "AmuxV22TaskChangedPaths_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "pathsSha256" ~ '^[0-9a-f]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "pathCount" >= 1 AND "byteLength" >= 2 * "pathCount"
  )
);

CREATE INDEX "AmuxV22TransferPart_createdAt_idx"
  ON "AmuxV22TransferPart"("createdAt");
CREATE UNIQUE INDEX "AmuxV22TaskChangedPaths_attemptId_taskId_key"
  ON "AmuxV22TaskChangedPaths"("attemptId", "taskId");
CREATE INDEX "AmuxV22TaskChangedPaths_ideaId_bodyPurgedAt_idx"
  ON "AmuxV22TaskChangedPaths"("ideaId", "bodyPurgedAt");

ALTER TABLE "AmuxV22TransferPart"
  ADD CONSTRAINT "AmuxV22TransferPart_attemptId_taskId_fkey"
    FOREIGN KEY ("attemptId", "taskId")
    REFERENCES "AmuxExecutionAttempt"("id", "taskId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22TransferChunk"
  ADD CONSTRAINT "AmuxV22TransferChunk_attemptId_part_fkey"
    FOREIGN KEY ("attemptId", "part")
    REFERENCES "AmuxV22TransferPart"("attemptId", "part")
    ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22TaskChangedPaths"
  ADD CONSTRAINT "AmuxV22TaskChangedPaths_attemptId_taskId_fkey"
    FOREIGN KEY ("attemptId", "taskId")
    REFERENCES "AmuxExecutionAttempt"("id", "taskId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22TaskChangedPaths_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22TaskChangedPaths_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Staging rows are written once and deleted; nothing rewrites a chunk or the
-- description its chunks were checked against.
CREATE FUNCTION amux_v22_transfer_staging_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AMUX v22 transfer staging is written once';
END;
$$;
CREATE TRIGGER "AmuxV22TransferPart_no_update"
  BEFORE UPDATE ON "AmuxV22TransferPart"
  FOR EACH ROW EXECUTE FUNCTION amux_v22_transfer_staging_no_update();
CREATE TRIGGER "AmuxV22TransferChunk_no_update"
  BEFORE UPDATE ON "AmuxV22TransferChunk"
  FOR EACH ROW EXECUTE FUNCTION amux_v22_transfer_staging_no_update();

-- The only change after the insert is the retention purge clearing the body.
CREATE FUNCTION amux_v22_task_changed_paths_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AMUX v22 task changed paths are immutable';
  END IF;
  IF OLD."attemptId" IS DISTINCT FROM NEW."attemptId" OR
     OLD."taskId" IS DISTINCT FROM NEW."taskId" OR
     OLD."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     OLD."digest" IS DISTINCT FROM NEW."digest" OR
     OLD."digestKeyId" IS DISTINCT FROM NEW."digestKeyId" OR
     OLD."pathsSha256" IS DISTINCT FROM NEW."pathsSha256" OR
     OLD."pathCount" IS DISTINCT FROM NEW."pathCount" OR
     OLD."byteLength" IS DISTINCT FROM NEW."byteLength" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR
     OLD."bodyPurgedAt" IS NOT NULL OR NEW."bodyPurgedAt" IS NULL OR
     OLD."ciphertext" IS NULL OR NEW."ciphertext" IS NOT NULL OR
     NEW."keyId" IS NOT NULL OR NEW."keyVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v22 task changed paths are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxV22TaskChangedPaths_immutable"
  BEFORE UPDATE OR DELETE ON "AmuxV22TaskChangedPaths"
  FOR EACH ROW EXECUTE FUNCTION amux_v22_task_changed_paths_immutable();

COMMIT;
