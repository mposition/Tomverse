-- Owner direction 2026-11-18 (chat): an ordinary card has no fixed number of
-- attempts and is no longer handed to a person or the Decision Maker for
-- failing the same way three times (lib/amux/executionBudgetCore.ts). The
-- review proposal guard still refused an owner's retry once a card had thirty
-- counted attempts ('AMUX review retry attempt budget exhausted'), so a card
-- past thirty could not be retried by a person at all. That bound is gone;
-- nothing else in the guard changes. A paid retry keeps its own bound in the
-- app (AMUX_V22_PAID_RETRY_ATTEMPT_LIMIT, AMUX_V22_READ_ONLY_RETRY_TASK_ATTEMPT_LIMIT).
-- baseline-check: replace-function-if-body-sha256 "amux_review_proposal_issue_guard" "f0f1e385bae02e2e73c9c9ed7fb432b081e85eeeddafb155554e6c685e2398dc" "e9349c8afecc506bc4ead1ed80c9b76c60f6f847337ec326de92744e557c6403"
CREATE OR REPLACE FUNCTION amux_review_proposal_issue_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_row "AmuxWorkItem"%ROWTYPE;
  escalation_row "AmuxHumanEscalation"%ROWTYPE;
  attempt_row "AmuxExecutionAttempt"%ROWTYPE;
  latest_attempt_id TEXT;
BEGIN
  NEW."issuedAt" := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  NEW."expiresAt" := NEW."issuedAt" + INTERVAL '24 hours';

  SELECT * INTO task_row FROM "AmuxWorkItem"
    WHERE "id" = NEW."taskId" FOR SHARE;
  SELECT * INTO escalation_row FROM "AmuxHumanEscalation"
    WHERE "id" = NEW."escalationId" FOR SHARE;
  IF task_row."id" IS NULL
     OR task_row."status" IS DISTINCT FROM NEW."sourceStatus"
     OR task_row."revision" IS DISTINCT FROM NEW."taskRevision"
     OR escalation_row."id" IS NULL
     OR escalation_row."taskId" IS DISTINCT FROM NEW."taskId"
     OR escalation_row."status" NOT IN ('open', 'acknowledged') THEN
    RAISE EXCEPTION 'AMUX review proposal does not match the current task and escalation'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Historical planning escalations have no opened revision. They cannot
  -- prove that the source was corrected, so retry proposal issuance fails
  -- closed instead of inventing a backfilled revision.
  IF escalation_row."specialty" = 'planning-review'
     AND NEW."outcome" = 'retry'
     AND (
       escalation_row."openedTaskRevision" IS NULL
       OR NEW."taskRevision" <= escalation_row."openedTaskRevision"
       OR task_row."dueParseState" <> 'valid'
     ) THEN
    RAISE EXCEPTION 'AMUX planning-review retry requires a newer task revision'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "id" INTO latest_attempt_id FROM "AmuxExecutionAttempt"
    WHERE "taskId" = NEW."taskId"
    ORDER BY "taskRevision" DESC, "startedAt" DESC, "id" DESC LIMIT 1;
  IF NEW."attemptId" IS DISTINCT FROM latest_attempt_id THEN
    RAISE EXCEPTION 'AMUX review proposal must bind the latest attempt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "AmuxWorkDelivery"
    WHERE "taskId" = NEW."taskId" AND "status" IN ('queued', 'leased')
  ) THEN
    RAISE EXCEPTION 'AMUX review proposal has an active delivery fence'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" = 'approve'
     AND task_row."reviewPrNumber" IS DISTINCT FROM NEW."reviewPrNumber" THEN
    RAISE EXCEPTION 'AMUX review proposal PR does not match the task source'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."attemptId" IS NOT NULL THEN
    SELECT * INTO attempt_row FROM "AmuxExecutionAttempt"
      WHERE "id" = NEW."attemptId" AND "taskId" = NEW."taskId" FOR SHARE;
    IF attempt_row."id" IS NULL OR attempt_row."endedAt" IS NULL
       OR attempt_row."outcome" IS NULL OR attempt_row."toStatus" IS NULL THEN
      RAISE EXCEPTION 'AMUX review proposal requires a terminal attempt'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sourceStatus" = 'review'
       AND (attempt_row."outcome" <> 'succeeded' OR attempt_row."toStatus" <> 'review'
         OR attempt_row."taskRevision" >= NEW."taskRevision") THEN
      RAISE EXCEPTION 'AMUX review approval requires a successful review attempt'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
