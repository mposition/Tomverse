-- A v22 worker's question to the owner (operator decision 2026-10-30). A v22
-- run is one CLI invocation and cannot wait, so a run that needs an owner
-- decision ends with one question line. The Task waits blocked instead of
-- going to review; the answer sends it back to todo for the same worker,
-- with the question, the answer and the previous change in its next prompt.
--
-- The question text stays in the attempt's encrypted AmuxV22TaskResult body;
-- this row keeps its digest. The answer is held in plain text only from the
-- answer until the resumed attempt settles, which clears it.
--
-- A question is also mirrored as a typed-ask card on the AMUX host's local
-- board so the Decision Maker can propose an answer; the operator's
-- confirmation in Admin answers it. "localCardId" names that card once and
-- "localCardClosedAt" records that the bridge closed it after the question
-- left "open".
BEGIN;

CREATE TABLE "AmuxV22TaskQuestion" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "worker" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "questionSha256" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "answerText" TEXT,
  "answerSource" TEXT,
  "answeredByUserId" TEXT,
  "answeredAt" TIMESTAMP(3),
  "resumedAttemptId" TEXT,
  "localCardId" TEXT,
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22TaskQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxV22TaskQuestion_shape_check" CHECK (
    "sequence" >= 1 AND "questionSha256" ~ '^[0-9a-f]{64}$' AND
    "worker" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND
    ("answerText" IS NULL OR char_length("answerText") BETWEEN 1 AND 8000) AND
    ("answerSource" IS NULL OR "answerSource" IN ('operator', 'dm_confirmed')) AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND "state" <> 'open'))
  ),
  CONSTRAINT "AmuxV22TaskQuestion_state_check" CHECK (
    ("state" IN ('open', 'cancelled') AND "answerText" IS NULL AND
      "answerSource" IS NULL AND "answeredByUserId" IS NULL AND
      "answeredAt" IS NULL AND "resumedAttemptId" IS NULL) OR
    ("state" = 'answered' AND "answerText" IS NOT NULL AND
      "answerSource" IS NOT NULL AND "answeredAt" IS NOT NULL AND
      "resumedAttemptId" IS NULL) OR
    ("state" = 'resumed' AND
      "answerSource" IS NOT NULL AND "answeredAt" IS NOT NULL AND
      "resumedAttemptId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AmuxV22TaskQuestion_attemptId_key"
  ON "AmuxV22TaskQuestion"("attemptId");
CREATE UNIQUE INDEX "AmuxV22TaskQuestion_attemptId_taskId_key"
  ON "AmuxV22TaskQuestion"("attemptId", "taskId");
CREATE UNIQUE INDEX "AmuxV22TaskQuestion_taskId_sequence_key"
  ON "AmuxV22TaskQuestion"("taskId", "sequence");
CREATE UNIQUE INDEX "AmuxV22TaskQuestion_localCardId_key"
  ON "AmuxV22TaskQuestion"("localCardId");
CREATE INDEX "AmuxV22TaskQuestion_state_createdAt_idx"
  ON "AmuxV22TaskQuestion"("state", "createdAt");
-- At most one question per Task is waiting for an answer or for its resume.
CREATE UNIQUE INDEX "AmuxV22TaskQuestion_one_live_per_task"
  ON "AmuxV22TaskQuestion"("taskId") WHERE "state" IN ('open', 'answered');

ALTER TABLE "AmuxV22TaskQuestion" ADD CONSTRAINT "AmuxV22TaskQuestion_attemptId_taskId_fkey"
  FOREIGN KEY ("attemptId", "taskId") REFERENCES "AmuxExecutionAttempt"("id", "taskId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22TaskQuestion" ADD CONSTRAINT "AmuxV22TaskQuestion_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Identity never changes and a row is never deleted. State moves only
-- forward: open -> answered | cancelled, answered -> resumed. Within a state
-- the answer stays as written, except that a resumed row loses its text; the
-- local card is named once and its close recorded once.
CREATE FUNCTION amux_v22_task_question_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AMUX v22 task question is never deleted';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR
     OLD."taskId" IS DISTINCT FROM NEW."taskId" OR
     OLD."attemptId" IS DISTINCT FROM NEW."attemptId" OR
     OLD."worker" IS DISTINCT FROM NEW."worker" OR
     OLD."sequence" IS DISTINCT FROM NEW."sequence" OR
     OLD."questionSha256" IS DISTINCT FROM NEW."questionSha256" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR
     (OLD."localCardId" IS NOT NULL AND
       OLD."localCardId" IS DISTINCT FROM NEW."localCardId") OR
     (OLD."localCardClosedAt" IS NOT NULL AND
       OLD."localCardClosedAt" IS DISTINCT FROM NEW."localCardClosedAt") THEN
    RAISE EXCEPTION 'AMUX v22 task question identity is immutable';
  END IF;
  IF OLD."state" = NEW."state" THEN
    IF NEW."answerSource" IS DISTINCT FROM OLD."answerSource" OR
       NEW."answeredByUserId" IS DISTINCT FROM OLD."answeredByUserId" OR
       NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt" OR
       NEW."resumedAttemptId" IS DISTINCT FROM OLD."resumedAttemptId" OR
       (NEW."answerText" IS DISTINCT FROM OLD."answerText" AND
         NOT (OLD."state" = 'resumed' AND NEW."answerText" IS NULL)) THEN
      RAISE EXCEPTION 'AMUX v22 task question cannot change its % answer',
        OLD."state";
    END IF;
  ELSIF NOT (
    (OLD."state" = 'open' AND NEW."state" IN ('answered', 'cancelled')) OR
    (OLD."state" = 'answered' AND NEW."state" = 'resumed' AND
      NEW."answerText" IS NOT DISTINCT FROM OLD."answerText" AND
      NEW."answerSource" IS NOT DISTINCT FROM OLD."answerSource" AND
      NEW."answeredByUserId" IS NOT DISTINCT FROM OLD."answeredByUserId" AND
      NEW."answeredAt" IS NOT DISTINCT FROM OLD."answeredAt")
  ) THEN
    RAISE EXCEPTION 'AMUX v22 task question cannot move from % to %',
      OLD."state", NEW."state";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxV22TaskQuestion_guard"
  BEFORE UPDATE OR DELETE ON "AmuxV22TaskQuestion"
  FOR EACH ROW EXECUTE FUNCTION amux_v22_task_question_guard();

COMMIT;
