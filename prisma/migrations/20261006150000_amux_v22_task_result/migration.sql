CREATE TABLE "AmuxV22TaskResult" (
  "attemptId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "ciphertext" BYTEA,
  "keyId" TEXT,
  "keyVersion" INTEGER,
  "digest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "sourceSha256" TEXT NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bodyPurgedAt" TIMESTAMP(3),
  CONSTRAINT "AmuxV22TaskResult_pkey" PRIMARY KEY ("attemptId"),
  CONSTRAINT "AmuxV22TaskResult_body_check" CHECK (
    ("ciphertext" IS NOT NULL AND "keyId" IS NOT NULL AND
      "keyVersion" > 0 AND "bodyPurgedAt" IS NULL) OR
    ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL)
  ),
  CONSTRAINT "AmuxV22TaskResult_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "sourceSha256" ~ '^[0-9a-f]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "byteLength" BETWEEN 1 AND 65536
  )
);

ALTER TABLE "AmuxIdeaContentKeyRetirement"
  DROP CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check",
  ADD CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check"
  CHECK ("purpose" IN ('idea_raw', 'transfer_payload',
    'analysis_freeform', 'analysis_draft', 'task_result'));

CREATE INDEX "AmuxV22TaskResult_taskId_createdAt_idx"
  ON "AmuxV22TaskResult"("taskId", "createdAt");
CREATE UNIQUE INDEX "AmuxV22TaskResult_attemptId_taskId_key"
  ON "AmuxV22TaskResult"("attemptId", "taskId");
CREATE INDEX "AmuxV22TaskResult_ideaId_bodyPurgedAt_idx"
  ON "AmuxV22TaskResult"("ideaId", "bodyPurgedAt");

ALTER TABLE "AmuxV22TaskResult" ADD CONSTRAINT "AmuxV22TaskResult_attemptId_taskId_fkey"
  FOREIGN KEY ("attemptId", "taskId") REFERENCES "AmuxExecutionAttempt"("id", "taskId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22TaskResult" ADD CONSTRAINT "AmuxV22TaskResult_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22TaskResult" ADD CONSTRAINT "AmuxV22TaskResult_ideaId_fkey"
  FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION amux_v22_task_result_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AMUX v22 task result is immutable';
  END IF;
  IF OLD."attemptId" IS DISTINCT FROM NEW."attemptId" OR
     OLD."taskId" IS DISTINCT FROM NEW."taskId" OR
     OLD."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     OLD."digest" IS DISTINCT FROM NEW."digest" OR
     OLD."digestKeyId" IS DISTINCT FROM NEW."digestKeyId" OR
     OLD."sourceSha256" IS DISTINCT FROM NEW."sourceSha256" OR
     OLD."byteLength" IS DISTINCT FROM NEW."byteLength" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR
     OLD."bodyPurgedAt" IS NOT NULL OR NEW."bodyPurgedAt" IS NULL OR
     OLD."ciphertext" IS NULL OR NEW."ciphertext" IS NOT NULL OR
     NEW."keyId" IS NOT NULL OR NEW."keyVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v22 task result is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxV22TaskResult_immutable"
  BEFORE UPDATE OR DELETE ON "AmuxV22TaskResult"
  FOR EACH ROW EXECUTE FUNCTION amux_v22_task_result_immutable();
