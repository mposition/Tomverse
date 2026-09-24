-- Durable, one-person AMUX task-review approval. This is not the two-person
-- AdminActionApproval contract and does not authorize external actions.
-- Contract: docs/policy/amux-agent-approval-contract.md v1.

-- The task's explicit PR identity is scoped to the single configured
-- mposition/Tomverse repository; it is never inferred from free text.
ALTER TABLE "AmuxWorkItem"
  ADD COLUMN "reviewPrNumber" INTEGER;
ALTER TABLE "AmuxWorkItem"
  ADD CONSTRAINT "AmuxWorkItem_review_pr_check"
    CHECK (
      "reviewPrNumber" IS NULL
      OR ("reviewPrNumber" > 0 AND "requiresHumanReview")
    );

ALTER TABLE "AmuxHumanEscalation"
  ADD COLUMN "resolutionOutcome" TEXT,
  ADD COLUMN "openedTaskRevision" INTEGER;

ALTER TABLE "AmuxHumanEscalation"
  ADD CONSTRAINT "AmuxHumanEscalation_opened_task_revision_check"
    CHECK ("openedTaskRevision" IS NULL OR "openedTaskRevision" >= 0),
  ADD CONSTRAINT "AmuxHumanEscalation_resolution_outcome_check"
    CHECK (
      ("status" = 'resolved' AND "resolutionOutcome" IS NOT NULL
        AND "resolutionOutcome" IN ('approve', 'retry', 'block'))
      OR ("status" <> 'resolved' AND "resolutionOutcome" IS NULL)
    ) NOT VALID;

-- Existing resolved rows may predate this approval contract and have no
-- machine-readable outcome. Do not invent one or block deployment. NOT VALID
-- preserves those rows while enforcing the new shape on every inserted or
-- updated row. Count legacy rows and validate in a separate evidence-backed
-- migration; an old unresolved row cannot become resolved without an outcome.

-- The composite key lets a proposal's escalation and task identity be one FK.
CREATE UNIQUE INDEX "AmuxHumanEscalation_id_taskId_key"
  ON "AmuxHumanEscalation"("id", "taskId");
CREATE UNIQUE INDEX "AmuxExecutionAttempt_id_taskId_key"
  ON "AmuxExecutionAttempt"("id", "taskId");

CREATE TABLE "AmuxReviewProposal" (
  "id" TEXT NOT NULL,
  "decisionId" UUID NOT NULL,
  "escalationId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "taskRevision" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "sourceStatus" TEXT NOT NULL,
  "targetStatus" TEXT NOT NULL,
  "subjectDigest" TEXT NOT NULL,
  "attemptId" TEXT,
  "reviewPrNumber" INTEGER,
  "reviewBaseSha" TEXT,
  "reviewHeadSha" TEXT,
  "reviewDiffDigest" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AmuxReviewProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxReviewProposal_revision_check"
    CHECK ("taskRevision" >= 0),
  CONSTRAINT "AmuxReviewProposal_transition_check"
    CHECK (
      ("sourceStatus" = 'review' AND "outcome" = 'approve' AND "targetStatus" = 'done')
      OR ("sourceStatus" = 'review' AND "outcome" = 'block' AND "targetStatus" = 'blocked')
      OR ("sourceStatus" = 'blocked' AND "outcome" = 'retry' AND "targetStatus" = 'todo')
      OR ("sourceStatus" = 'blocked' AND "outcome" = 'block' AND "targetStatus" = 'blocked')
    ),
  CONSTRAINT "AmuxReviewProposal_review_attempt_check"
    CHECK ("sourceStatus" <> 'review' OR "attemptId" IS NOT NULL),
  CONSTRAINT "AmuxReviewProposal_subject_digest_check"
    CHECK ("subjectDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AmuxReviewProposal_github_source_check"
    CHECK (
      (
        "outcome" = 'approve'
        AND "reviewPrNumber" IS NOT NULL
        AND "reviewPrNumber" > 0
        AND "reviewBaseSha" IS NOT NULL
        AND "reviewBaseSha" ~ '^[0-9a-f]{40}$'
        AND "reviewHeadSha" IS NOT NULL
        AND "reviewHeadSha" ~ '^[0-9a-f]{40}$'
        AND "reviewDiffDigest" IS NOT NULL
        AND "reviewDiffDigest" ~ '^[0-9a-f]{64}$'
      )
      OR (
        "outcome" <> 'approve'
        AND "reviewPrNumber" IS NULL
        AND "reviewBaseSha" IS NULL
        AND "reviewHeadSha" IS NULL
        AND "reviewDiffDigest" IS NULL
      )
    ),
  CONSTRAINT "AmuxReviewProposal_expiry_check"
    CHECK ("expiresAt" = "issuedAt" + INTERVAL '24 hours')
);

ALTER TABLE "AmuxReviewProposal"
  ADD CONSTRAINT "AmuxReviewProposal_outcome_check"
    CHECK ("outcome" IN ('approve', 'retry', 'block'));

CREATE UNIQUE INDEX "AmuxReviewProposal_id_escalationId_key"
  ON "AmuxReviewProposal"("id", "escalationId");
CREATE UNIQUE INDEX "AmuxReviewProposal_decisionId_key"
  ON "AmuxReviewProposal"("decisionId");
CREATE INDEX "AmuxReviewProposal_escalationId_issuedAt_idx"
  ON "AmuxReviewProposal"("escalationId", "issuedAt");
CREATE INDEX "AmuxReviewProposal_taskId_taskRevision_issuedAt_idx"
  ON "AmuxReviewProposal"("taskId", "taskRevision", "issuedAt");
CREATE INDEX "AmuxReviewProposal_expiresAt_idx"
  ON "AmuxReviewProposal"("expiresAt");

ALTER TABLE "AmuxReviewProposal"
  ADD CONSTRAINT "AmuxReviewProposal_escalationId_taskId_fkey"
    FOREIGN KEY ("escalationId", "taskId")
    REFERENCES "AmuxHumanEscalation"("id", "taskId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxReviewProposal_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxReviewProposal_attemptId_taskId_fkey"
    FOREIGN KEY ("attemptId", "taskId")
    REFERENCES "AmuxExecutionAttempt"("id", "taskId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxReviewDecision" (
  "id" UUID NOT NULL,
  "proposalId" TEXT NOT NULL,
  "escalationId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "idempotencyKeyHash" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AmuxReviewDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxReviewDecision_digests_check"
    CHECK (
      "requestDigest" ~ '^[0-9a-f]{64}$'
      AND "idempotencyKeyHash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "AmuxReviewDecision_actor_check"
    CHECK ("actorUserId" <> '')
);

ALTER TABLE "AmuxReviewDecision"
  ADD CONSTRAINT "AmuxReviewDecision_outcome_check"
    CHECK ("outcome" IN ('approve', 'retry', 'block'));

-- proposalId is the idempotency scope: one successful decision per proposal.
-- escalationId also prevents two different proposals resolving one escalation.
CREATE UNIQUE INDEX "AmuxReviewDecision_proposalId_key"
  ON "AmuxReviewDecision"("proposalId");
CREATE UNIQUE INDEX "AmuxReviewDecision_proposalId_escalationId_key"
  ON "AmuxReviewDecision"("proposalId", "escalationId");
CREATE UNIQUE INDEX "AmuxReviewDecision_escalationId_key"
  ON "AmuxReviewDecision"("escalationId");
CREATE UNIQUE INDEX "AmuxReviewDecision_auditLogId_key"
  ON "AmuxReviewDecision"("auditLogId");
CREATE INDEX "AmuxReviewDecision_actorUserId_decidedAt_idx"
  ON "AmuxReviewDecision"("actorUserId", "decidedAt");

ALTER TABLE "AmuxReviewDecision"
  ADD CONSTRAINT "AmuxReviewDecision_proposalId_escalationId_fkey"
    FOREIGN KEY ("proposalId", "escalationId")
    REFERENCES "AmuxReviewProposal"("id", "escalationId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxReviewDecision_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Proposal facts cannot be rewritten after an operator has seen them.
-- A decision is a separate insert, never a consumedAt update on the proposal.
CREATE FUNCTION amux_review_ledger_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % of % refused', TG_TABLE_NAME, TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "AmuxReviewProposal_append_only"
  BEFORE UPDATE OR DELETE ON "AmuxReviewProposal" FOR EACH ROW
  EXECUTE FUNCTION amux_review_ledger_append_only_guard();
CREATE TRIGGER "AmuxReviewDecision_append_only"
  BEFORE UPDATE OR DELETE ON "AmuxReviewDecision" FOR EACH ROW
  EXECUTE FUNCTION amux_review_ledger_append_only_guard();

-- Issue only against an unresolved escalation and the task revision/status
-- actually being reviewed. A terminal attempt is required for review, while a
-- blocked planning-review can legitimately have no attempt. Both timestamps
-- supplied by Prisma are deliberately overwritten using one DB UTC clock read;
-- a caller cannot extend the approved 24-hour lifetime with a future issue time.
CREATE FUNCTION amux_review_proposal_issue_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_row "AmuxWorkItem"%ROWTYPE;
  escalation_row "AmuxHumanEscalation"%ROWTYPE;
  attempt_row "AmuxExecutionAttempt"%ROWTYPE;
  latest_attempt_id TEXT;
  attempts_used BIGINT;
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
  IF NEW."outcome" = 'retry' THEN
    SELECT GREATEST(COUNT(*), COALESCE(MAX("attemptNumber"), 0))
      INTO attempts_used FROM "AmuxExecutionAttempt"
      WHERE "taskId" = NEW."taskId";
    IF attempts_used >= 5 THEN
      RAISE EXCEPTION 'AMUX review retry attempt budget exhausted'
        USING ERRCODE = 'check_violation';
    END IF;
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
CREATE TRIGGER "AmuxReviewProposal_issue_guard"
  BEFORE INSERT ON "AmuxReviewProposal" FOR EACH ROW
  EXECUTE FUNCTION amux_review_proposal_issue_guard();

-- The write path first moves the task and closes the escalation, then writes
-- an append-only admin audit entry and finally this decision, all in one DB
-- transaction. These checks make cross-row substitutions fail at the DB edge.
CREATE FUNCTION amux_review_decision_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal_row "AmuxReviewProposal"%ROWTYPE;
  escalation_row "AmuxHumanEscalation"%ROWTYPE;
  task_row "AmuxWorkItem"%ROWTYPE;
  audit_row "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT * INTO proposal_row FROM "AmuxReviewProposal"
    WHERE "id" = NEW."proposalId" FOR SHARE;
  SELECT * INTO escalation_row FROM "AmuxHumanEscalation"
    WHERE "id" = NEW."escalationId" FOR SHARE;
  SELECT * INTO task_row FROM "AmuxWorkItem"
    WHERE "id" = proposal_row."taskId" FOR SHARE;
  SELECT * INTO audit_row FROM "AdminAuditLog"
    WHERE "id" = NEW."auditLogId" FOR KEY SHARE;

  IF proposal_row."id" IS NULL
     OR proposal_row."decisionId" IS DISTINCT FROM NEW."id"
     OR proposal_row."escalationId" IS DISTINCT FROM NEW."escalationId"
     OR proposal_row."outcome" IS DISTINCT FROM NEW."outcome"
     OR (clock_timestamp() AT TIME ZONE 'UTC') >= proposal_row."expiresAt" THEN
    RAISE EXCEPTION 'AMUX review decision has a mismatched or expired proposal'
      USING ERRCODE = 'check_violation';
  END IF;
  IF escalation_row."id" IS NULL
     OR escalation_row."status" <> 'resolved'
     OR escalation_row."resolutionOutcome" IS DISTINCT FROM NEW."outcome"
     OR escalation_row."resolvedById" IS DISTINCT FROM NEW."actorUserId" THEN
    RAISE EXCEPTION 'AMUX review decision does not match the resolved escalation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF task_row."id" IS NULL
     OR task_row."status" IS DISTINCT FROM proposal_row."targetStatus"
     OR task_row."revision" IS DISTINCT FROM proposal_row."taskRevision" + 1
     OR (
       proposal_row."outcome" = 'approve'
       AND task_row."reviewPrNumber" IS DISTINCT FROM proposal_row."reviewPrNumber"
     ) THEN
    RAISE EXCEPTION 'AMUX review decision does not match the task CAS transition'
      USING ERRCODE = 'check_violation';
  END IF;
  IF audit_row."id" IS NULL
     OR audit_row."actorUserId" IS DISTINCT FROM NEW."actorUserId"
     OR audit_row."action" <> 'amux.human_escalation.resolved'
     OR audit_row."targetType" <> 'AmuxWorkItem'
     OR audit_row."targetId" IS DISTINCT FROM proposal_row."taskId"
     OR audit_row."metadata"->>'decision_id' IS DISTINCT FROM NEW."id"::text
     OR audit_row."metadata"->>'proposal_id' IS DISTINCT FROM NEW."proposalId"
     OR audit_row."metadata"->>'escalation_id' IS DISTINCT FROM NEW."escalationId"
     OR audit_row."metadata"->>'outcome' IS DISTINCT FROM NEW."outcome"
     OR audit_row."metadata"->>'review_base_sha' IS DISTINCT FROM proposal_row."reviewBaseSha"
     OR audit_row."metadata"->>'subject_digest' IS DISTINCT FROM proposal_row."subjectDigest" THEN
    RAISE EXCEPTION 'AMUX review decision does not match its admin audit entry'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxReviewDecision_insert_guard"
  BEFORE INSERT ON "AmuxReviewDecision" FOR EACH ROW
  EXECUTE FUNCTION amux_review_decision_insert_guard();
