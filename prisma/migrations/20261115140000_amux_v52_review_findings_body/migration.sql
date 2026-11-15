-- A rejected v52 review keeps its findings as one sealed AMUX content unit
-- (owner decision 2026-11-15): the reviewers, each one's reason, and per
-- finding its severity, summary, file and line, so the owner, the Decision
-- Maker and the next attempt read why the review rejected a run instead of a
-- job id. Same shape as AmuxV22TaskPatch: a per-attempt external key, a body
-- the retention purge clears once, and the key's deletion queued in the
-- content key retirement ledger. The review record row stays append-only.

CREATE TABLE "AmuxV52ReviewFindings" (
  "attemptId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "ciphertext" BYTEA,
  "keyId" TEXT,
  "keyVersion" INTEGER,
  "digest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "findingCount" INTEGER NOT NULL,
  "repeatsPrior" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bodyPurgedAt" TIMESTAMP(3),
  CONSTRAINT "AmuxV52ReviewFindings_pkey" PRIMARY KEY ("attemptId"),
  CONSTRAINT "AmuxV52ReviewFindings_body_check" CHECK (
    ("ciphertext" IS NOT NULL AND "keyId" IS NOT NULL AND
      "keyVersion" > 0 AND "bodyPurgedAt" IS NULL) OR
    ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL)
  ),
  CONSTRAINT "AmuxV52ReviewFindings_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "byteLength" BETWEEN 1 AND 1048576 AND
    "findingCount" BETWEEN 0 AND 100000
  )
);

ALTER TABLE "AmuxIdeaContentKeyRetirement"
  DROP CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check",
  ADD CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check"
    CHECK ("purpose" IN ('idea_raw', 'transfer_payload', 'analysis_freeform',
      'analysis_draft', 'task_result', 'task_patch',
      'repository_read_manifest', 'analysis_result', 'review_findings'));

CREATE UNIQUE INDEX "AmuxV52ReviewFindings_attemptId_taskId_key"
  ON "AmuxV52ReviewFindings"("attemptId", "taskId");
CREATE INDEX "AmuxV52ReviewFindings_taskId_createdAt_idx"
  ON "AmuxV52ReviewFindings"("taskId", "createdAt");
CREATE INDEX "AmuxV52ReviewFindings_ideaId_bodyPurgedAt_idx"
  ON "AmuxV52ReviewFindings"("ideaId", "bodyPurgedAt");

ALTER TABLE "AmuxV52ReviewFindings"
  ADD CONSTRAINT "AmuxV52ReviewFindings_attemptId_taskId_fkey"
    FOREIGN KEY ("attemptId", "taskId")
    REFERENCES "AmuxV52ReviewRecord"("attemptId", "taskId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV52ReviewFindings_attempt_fkey"
    FOREIGN KEY ("attemptId", "taskId")
    REFERENCES "AmuxExecutionAttempt"("id", "taskId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV52ReviewFindings_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV52ReviewFindings_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Findings belong to a rejected review only, and the only change after the
-- insert is the retention purge clearing the body once.
CREATE FUNCTION amux_v52_review_findings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "AmuxV52ReviewRecord" r
        WHERE r."attemptId" = NEW."attemptId" AND r."taskId" = NEW."taskId" AND
          r."verdict" = 'reject') THEN
      RAISE EXCEPTION 'AMUX v52 review findings belong to a rejected review'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AMUX v52 review findings are immutable';
  END IF;
  IF OLD."attemptId" IS DISTINCT FROM NEW."attemptId" OR
     OLD."taskId" IS DISTINCT FROM NEW."taskId" OR
     OLD."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     OLD."digest" IS DISTINCT FROM NEW."digest" OR
     OLD."digestKeyId" IS DISTINCT FROM NEW."digestKeyId" OR
     OLD."byteLength" IS DISTINCT FROM NEW."byteLength" OR
     OLD."findingCount" IS DISTINCT FROM NEW."findingCount" OR
     OLD."repeatsPrior" IS DISTINCT FROM NEW."repeatsPrior" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR
     OLD."bodyPurgedAt" IS NOT NULL OR NEW."bodyPurgedAt" IS NULL OR
     OLD."ciphertext" IS NULL OR NEW."ciphertext" IS NOT NULL OR
     NEW."keyId" IS NOT NULL OR NEW."keyVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v52 review findings are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxV52ReviewFindings_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxV52ReviewFindings"
  FOR EACH ROW EXECUTE FUNCTION amux_v52_review_findings_guard();
