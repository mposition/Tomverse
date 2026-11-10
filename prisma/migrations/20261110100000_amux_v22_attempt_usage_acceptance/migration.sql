-- baseline-check: present-if-relation "AmuxV22AttemptUsageAcceptance"
-- Owner decision 2026-11-10: the owner may accept that one ended v22 attempt's
-- CLI usage stays unknown, and an owner-approved retry of a Task accepts the
-- Task's earlier unknown attempts.
--
-- lib/amux/v22WorkerUsageGate.ts refuses a worker every new cost-bound Task
-- while it has an ended attempt with no complete usage report. Before this the
-- only release was archiving the card (owner decision 2026-11-06), and Admin
-- archives only every active card at once. From 2026-11-09 19:54 AEST three
-- such attempts (two after an expired Codex login, one partial Claude report)
-- held codex-impl, codex-chore and claude-impl, and no Task was assigned.
--
-- One row is the owner's acceptance for one attempt. It is written in the
-- transaction of the human (or, for a one-click pre-approval, the system
-- applying the owner's own consent) audit that names the attempt, and it is
-- append-only. The usage gate leaves an attempt with a row out. Nothing else
-- changes: the attempt's reserved cap, settled cost, costConfirmed flag and
-- usage rows stay as they are, so the unknown cost is never read as zero.
BEGIN;

CREATE TABLE "AmuxV22AttemptUsageAcceptance" (
  "id" UUID NOT NULL,
  "attemptId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "acceptedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22AttemptUsageAcceptance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxV22AttemptUsageAcceptance_source_check" CHECK (
    "source" IN ('owner_accept', 'recovery_approval', 'review_retry'))
);
CREATE UNIQUE INDEX "AmuxV22AttemptUsageAcceptance_attemptId_key"
  ON "AmuxV22AttemptUsageAcceptance"("attemptId");
CREATE INDEX "AmuxV22AttemptUsageAcceptance_taskId_idx"
  ON "AmuxV22AttemptUsageAcceptance"("taskId");
ALTER TABLE "AmuxV22AttemptUsageAcceptance"
  ADD CONSTRAINT "AmuxV22AttemptUsageAcceptance_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "AmuxExecutionAttempt"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22AttemptUsageAcceptance"
  ADD CONSTRAINT "AmuxV22AttemptUsageAcceptance_authorizationAuditLogId_fkey"
  FOREIGN KEY ("authorizationAuditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER amux_v22_attempt_usage_acceptance_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
 ON "AmuxV22AttemptUsageAcceptance" FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_recovery_append_only();

-- The acceptance names an ended attempt of this v4 Task, and the audit row that
-- authorizes it was written in this transaction by the chained writer:
--  * owner_accept: the owner's own audit for exactly this attempt;
--  * recovery_approval: the recovery approval's audit (the owner's, or the
--    pre-approval actor's applying that owner's consent), for the approval
--    written with it, listing this attempt;
--  * review_retry: the owner's retry decision on this Task, listing this
--    attempt, with the decision bound to that audit.
CREATE FUNCTION amux_v22_attempt_usage_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a "AdminAuditLog"%ROWTYPE; attempt "AmuxExecutionAttempt"%ROWTYPE;
 w "AmuxWorkItem"%ROWTYPE; bound BOOLEAN;
BEGIN
  SELECT * INTO attempt FROM "AmuxExecutionAttempt" WHERE "id" = NEW."attemptId";
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  SELECT * INTO a FROM "AdminAuditLog" WHERE "id" = NEW."authorizationAuditLogId";
  bound := attempt."id" IS NOT NULL AND attempt."taskId" = NEW."taskId" AND
    attempt."endedAt" IS NOT NULL AND w."sourceSystem" = 'admin-idea-v4' AND
    a."id" IS NOT NULL AND a."entryHash" IS NOT NULL AND
    a.xmin = pg_current_xact_id()::xid AND
    CASE NEW."source"
      WHEN 'owner_accept' THEN
        a."action" = 'amux.v22.attempt_usage.unknown_accepted' AND
        a."targetType" = 'AmuxExecutionAttempt' AND a."targetId" = NEW."attemptId" AND
        a."actorUserId" = NEW."acceptedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
        a."metadata"->>'taskId' = NEW."taskId"
      WHEN 'recovery_approval' THEN
        a."targetType" = 'AmuxV22TaskRecoveryApproval' AND
        a."metadata"->>'taskId' = NEW."taskId" AND
        a."metadata"->'acceptedUnknownUsageAttemptIds' ? NEW."attemptId" AND
        ((a."action" = 'amux.v22.recovery.approved' AND
          a."actorUserId" = NEW."acceptedByUserId" AND NOT (a."metadata" ? 'systemActor')) OR
         (a."action" = 'amux.v22.recovery.preapproval_applied' AND a."actorUserId" IS NULL AND
          a."metadata"->>'systemActor' = 'amux-v22-recovery-preapproval' AND
          a."metadata"->>'approvedByUserId' = NEW."acceptedByUserId")) AND
        EXISTS (SELECT 1 FROM "AmuxV22TaskRecoveryApproval" ap
          WHERE ap."id"::text = a."targetId" AND ap."taskId" = NEW."taskId" AND
            ap."authorizationAuditLogId" = a."id" AND
            ap."approvedByUserId" = NEW."acceptedByUserId" AND
            ap.xmin = pg_current_xact_id()::xid)
      WHEN 'review_retry' THEN
        a."action" = 'amux.human_escalation.resolved' AND
        a."targetType" = 'AmuxWorkItem' AND a."targetId" = NEW."taskId" AND
        a."actorUserId" = NEW."acceptedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
        a."metadata"->>'outcome' = 'retry' AND
        a."metadata"->'accepted_unknown_usage_attempt_ids' ? NEW."attemptId" AND
        EXISTS (SELECT 1 FROM "AmuxReviewDecision" d
          WHERE d."auditLogId" = a."id" AND d."outcome" = 'retry' AND
            d."actorUserId" = NEW."acceptedByUserId" AND
            d.xmin = pg_current_xact_id()::xid)
      ELSE FALSE
    END;
  IF bound IS NOT TRUE THEN
    RAISE EXCEPTION 'Attempt usage acceptance is not exact and owner audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22AttemptUsageAcceptance_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_attempt_usage_acceptance_guard_trigger AFTER INSERT
 ON "AmuxV22AttemptUsageAcceptance" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_attempt_usage_acceptance_guard();

COMMIT;
