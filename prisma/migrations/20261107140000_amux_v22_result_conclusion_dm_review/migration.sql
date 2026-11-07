-- baseline-check: present-if-relation "AmuxV22ResultReview"
-- Owner decision 2026-11-07: the Decision Maker replaces the operator for
-- reversible approvals; only irreversible actions stay with a person.
--
-- 1. An investigate run ends with a structured conclusion. The verdict and the
--    digest of the parsed conclusion are kept beside the encrypted result
--    body; the findings stay inside the body and leave with it at the purge.
-- 2. A v22 result that waits for review (no publication product) gets a
--    result review row the relay files as a typed-ask card, so the Decision
--    Maker can approve, retry or block it. The human escalation stays open
--    beside it; whichever answers first wins.
-- 3. "dm" is a new answer source: a Decision Maker proposal the app applied
--    without the operator's confirmation, behind its default-off switch.
BEGIN;

ALTER TABLE "AmuxV22TaskResult"
  ADD COLUMN "conclusionVerdict" TEXT,
  ADD COLUMN "conclusionSha256" TEXT,
  ADD CONSTRAINT "AmuxV22TaskResult_conclusion_check" CHECK (
    ("conclusionVerdict" IS NULL AND "conclusionSha256" IS NULL) OR
    ("conclusionVerdict" IS NOT NULL AND "conclusionSha256" IS NOT NULL AND
      "conclusionVerdict" IN ('proceed', 'replan', 'stop', 'needs_owner') AND
      "conclusionSha256" ~ '^[0-9a-f]{64}$')
  );

CREATE TABLE "AmuxV22ResultReview" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "decision" TEXT,
  "answerSource" TEXT,
  "requestId" TEXT,
  "cancelReason" TEXT,
  "handoffReason" TEXT,
  "handoffAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "localCardId" TEXT,
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22ResultReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxV22ResultReview_shape_check" CHECK (
    -- The local AMUX files a question only under a lowercase UUID.
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
    "kind" IN ('needs_owner', 'conclusion_invalid', 'result_review', 'prless_implement') AND
    ("answerSource" IS NULL OR "answerSource" IN ('dm', 'dm_confirmed')) AND
    ("cancelReason" IS NULL OR "cancelReason" ~ '^[a-z_]{1,64}$') AND
    (("handoffReason" IS NULL) = ("handoffAt" IS NULL)) AND
    ("handoffReason" IS NULL OR "handoffReason" ~ '^[a-z_]{1,64}$') AND
    ("requestId" IS NULL OR "requestId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    -- A handed-off review's card closes too: the person decides elsewhere.
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND
      ("state" <> 'open' OR "handoffAt" IS NOT NULL)))
  ),
  CONSTRAINT "AmuxV22ResultReview_state_check" CHECK (
    ("state" = 'open' AND "decision" IS NULL AND "answerSource" IS NULL AND
      "decidedAt" IS NULL AND "cancelReason" IS NULL) OR
    ("state" = 'applied' AND "decision" IS NOT NULL AND
      "decision" IN ('approve', 'retry', 'block') AND
      "answerSource" IS NOT NULL AND "decidedAt" IS NOT NULL AND
      "cancelReason" IS NULL) OR
    ("state" = 'cancelled' AND "decision" IS NULL AND "cancelReason" IS NOT NULL)
  ),
  CONSTRAINT "AmuxV22ResultReview_taskId_fkey" FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22ResultReview_attemptId_taskId_fkey"
    FOREIGN KEY ("attemptId", "taskId")
    REFERENCES "AmuxExecutionAttempt"("id", "taskId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AmuxV22ResultReview_attemptId_key"
  ON "AmuxV22ResultReview"("attemptId");
CREATE UNIQUE INDEX "AmuxV22ResultReview_attemptId_taskId_key"
  ON "AmuxV22ResultReview"("attemptId", "taskId");
CREATE UNIQUE INDEX "AmuxV22ResultReview_localCardId_key"
  ON "AmuxV22ResultReview"("localCardId");
CREATE INDEX "AmuxV22ResultReview_state_createdAt_idx"
  ON "AmuxV22ResultReview"("state", "createdAt");
CREATE INDEX "AmuxV22ResultReview_taskId_createdAt_idx"
  ON "AmuxV22ResultReview"("taskId", "createdAt");

-- "dm": applied without the operator's confirmation (no user id), like
-- "dm_confirmed", whose person is named by the judgment audit instead.
ALTER TABLE "AmuxV22TaskQuestion"
  DROP CONSTRAINT "AmuxV22TaskQuestion_shape_check",
  ADD CONSTRAINT "AmuxV22TaskQuestion_shape_check" CHECK (
    "sequence" >= 1 AND "questionSha256" ~ '^[0-9a-f]{64}$' AND
    "worker" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND
    ("answerText" IS NULL OR char_length("answerText") BETWEEN 1 AND 8000) AND
    ("answerSource" IS NULL OR "answerSource" IN ('operator', 'dm_confirmed', 'dm')) AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND "state" <> 'open'))
  );

ALTER TABLE "AmuxIdeaCardCloseQuestion"
  DROP CONSTRAINT "AmuxIdeaCardCloseQuestion_shape_check",
  ADD CONSTRAINT "AmuxIdeaCardCloseQuestion_shape_check" CHECK (
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
    "reasonCode" IN ('blocked_task', 'stale_cards') AND
    jsonb_typeof("cards") = 'array' AND jsonb_array_length("cards") >= 1 AND
    ("answerSource" IS NULL OR "answerSource" IN ('operator', 'dm_confirmed', 'dm')) AND
    ("answerSource" IS DISTINCT FROM 'operator' OR "answeredByUserId" IS NOT NULL) AND
    ("answerSource" NOT IN ('dm_confirmed', 'dm') OR "answeredByUserId" IS NULL) AND
    (("answerSource" IS NULL) = ("answeredAt" IS NULL)) AND
    ("answerSource" IS NOT NULL OR "answeredByUserId" IS NULL) AND
    ("cancelReason" IS NULL OR "cancelReason" ~ '^[a-z_]{1,64}$') AND
    (("handoffReason" IS NULL) = ("handoffAt" IS NULL)) AND
    ("handoffReason" IS NULL OR "handoffReason" ~ '^[a-z_]{1,64}$') AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND "state" <> 'open'))
  );

ALTER TABLE "AmuxIdeaSessionPlanRefusal"
  DROP CONSTRAINT "AmuxIdeaSessionPlanRefusal_state_check",
  ADD CONSTRAINT "AmuxIdeaSessionPlanRefusal_state_check" CHECK (
    ("state" = 'open' AND "decisionSource" IS NULL AND
      "decidedByUserId" IS NULL AND "decidedAt" IS NULL) OR
    ("state" IN ('retry', 'stopped') AND "decidedAt" IS NOT NULL AND
      (("decisionSource" = 'operator' AND "decidedByUserId" IS NOT NULL) OR
       ("decisionSource" IN ('dm_confirmed', 'dm') AND "decidedByUserId" IS NULL)))
  );

COMMIT;
