-- baseline-check: present-if-function "chat_unified_optimizer_queued_closure_guard"
-- A queued provider-free role has no external dispatch and therefore may be
-- closed as an explicit cancellation before its deadline or an expiry after
-- it. Claimed work is deliberately excluded: its outcome remains latched for
-- exact read-back and is never guessed by this migration. This supersedes the
-- broad wording in the 20261016201000 deadline migration; only this audited
-- queued-before-dispatch transition is a known failed closure after deadline.

ALTER TABLE "ChatUnifiedOptimizerRoleJob"
  DROP CONSTRAINT "ChatUnifiedOptimizerRoleJob_closed_check",
  ADD CONSTRAINT "ChatUnifiedOptimizerRoleJob_closed_check" CHECK (
    "role" IN ('candidate_author', 'case_author', 'case_reviewer',
      'judge_primary', 'judge_secondary', 'coordinator')
    AND "purpose" = 'provider_free_validation'
    AND "state" IN ('queued', 'claimed', 'succeeded', 'failed', 'outcome_unknown')
    AND NOT "externalDispatchAuthorized"
    AND NOT "paidAuthorized"
    AND ("claimRequestDigest" IS NULL OR "claimRequestDigest" ~ '^[0-9a-f]{64}$')
    AND ("terminalRequestDigest" IS NULL OR "terminalRequestDigest" ~ '^[0-9a-f]{64}$')
    AND ("terminalOutcome" IS NULL OR
      "terminalOutcome" IN ('succeeded', 'failed', 'outcome_unknown'))
    AND (("state" = 'queued'
          AND "claimRequestId" IS NULL AND "claimRequestDigest" IS NULL
          AND "claimToken" IS NULL AND "claimAuditLogId" IS NULL
          AND "claimedAt" IS NULL AND "terminalRequestId" IS NULL
          AND "terminalRequestDigest" IS NULL AND "terminalOutcome" IS NULL
          AND "terminalAuditLogId" IS NULL AND "terminalAt" IS NULL)
      OR ("state" = 'claimed'
          AND "claimRequestId" IS NOT NULL AND "claimRequestDigest" IS NOT NULL
          AND "claimToken" IS NOT NULL AND "claimAuditLogId" IS NOT NULL
          AND "claimedAt" IS NOT NULL AND "terminalRequestId" IS NULL
          AND "terminalRequestDigest" IS NULL AND "terminalOutcome" IS NULL
          AND "terminalAuditLogId" IS NULL AND "terminalAt" IS NULL)
      OR ("state" IN ('succeeded', 'failed', 'outcome_unknown')
          AND "claimRequestId" IS NOT NULL AND "claimRequestDigest" IS NOT NULL
          AND "claimToken" IS NOT NULL AND "claimAuditLogId" IS NOT NULL
          AND "claimedAt" IS NOT NULL AND "terminalRequestId" IS NOT NULL
          AND "terminalRequestDigest" IS NOT NULL
          AND "terminalOutcome" = "state"
          AND "terminalAuditLogId" IS NOT NULL AND "terminalAt" IS NOT NULL)
      OR ("state" = 'failed'
          AND "claimRequestId" IS NULL AND "claimRequestDigest" IS NULL
          AND "claimToken" IS NULL AND "claimAuditLogId" IS NULL
          AND "claimedAt" IS NULL AND "terminalRequestId" IS NOT NULL
          AND "terminalRequestDigest" IS NOT NULL
          AND "terminalOutcome" = 'failed'
          AND "terminalAuditLogId" IS NOT NULL AND "terminalAt" IS NOT NULL))
  );

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_job_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_row "AdminAuditLog"%ROWTYPE;
  run_cycle_id UUID;
  run_state TEXT;
  cycle_state TEXT;
  close_reason TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_job_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    IF NEW."state" <> 'queued' OR NEW."deadlineAt" <= NEW."createdAt" THEN
      RAISE EXCEPTION 'chat_unified_optimizer_job_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."runId", NEW."role", NEW."purpose",
      NEW."externalDispatchAuthorized", NEW."paidAuthorized",
      NEW."deadlineAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."runId", OLD."role", OLD."purpose",
      OLD."externalDispatchAuthorized", OLD."paidAuthorized",
      OLD."deadlineAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_job_identity_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."state" = 'queued' AND NEW."state" = 'claimed' THEN
    NEW."claimedAt" := clock_timestamp();
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."claimAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    IF NEW."claimedAt" >= NEW."deadlineAt"
      OR NEW."claimRequestId" IS NULL OR NEW."claimRequestDigest" IS NULL
      OR NEW."claimToken" IS NULL OR NEW."claimAuditLogId" IS NULL
      OR NEW."terminalRequestId" IS NOT NULL OR NEW."terminalAuditLogId" IS NOT NULL
      OR (OLD."claimRequestId", OLD."claimRequestDigest", OLD."claimToken",
          OLD."claimAuditLogId", OLD."claimedAt")
         IS DISTINCT FROM (NULL::uuid, NULL::text, NULL::uuid, NULL::text,
           NULL::timestamptz)
      OR audit_row."id" IS NULL
      OR audit_row."action" <> 'chat.unified_optimizer.dispatch_intended'
      OR audit_row."targetType" <> 'ChatUnifiedOptimizerRoleJob'
      OR audit_row."targetId" <> NEW."id"::text
      OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
      OR audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL
      OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR audit_row."metadata"->>'purpose' <> 'provider_free_validation'
      OR audit_row."metadata"->>'role' <> NEW."role"
      OR audit_row."metadata"->>'claimRequestDigest' <> NEW."claimRequestDigest"
      OR audit_row."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR audit_row."metadata"->>'paidAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_claim_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" = 'queued' AND NEW."state" = 'failed' THEN
    NEW."terminalAt" := clock_timestamp();
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."terminalAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    SELECT r."cycleId", r."state", c."state"
      INTO run_cycle_id, run_state, cycle_state
      FROM "ChatUnifiedOptimizerRun" r
      JOIN "ChatUnifiedOptimizerCycle" c ON c."id" = r."cycleId"
      WHERE r."id" = NEW."runId";
    close_reason := audit_row."metadata"->>'closeReason';
    IF (OLD."claimRequestId", OLD."claimRequestDigest", OLD."claimToken",
        OLD."claimAuditLogId", OLD."claimedAt", OLD."terminalRequestId",
        OLD."terminalRequestDigest", OLD."terminalOutcome",
        OLD."terminalAuditLogId", OLD."terminalAt") IS DISTINCT FROM
       (NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::timestamptz)
      OR (NEW."claimRequestId", NEW."claimRequestDigest", NEW."claimToken",
          NEW."claimAuditLogId", NEW."claimedAt") IS DISTINCT FROM
         (NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::timestamptz)
      OR NEW."terminalRequestId" IS NULL OR NEW."terminalRequestDigest" IS NULL
      OR NEW."terminalOutcome" <> 'failed' OR NEW."terminalAuditLogId" IS NULL
      OR run_cycle_id IS NULL OR run_state <> 'active' OR cycle_state <> 'active'
      OR close_reason IS NULL
      OR close_reason NOT IN ('expired_before_dispatch', 'cancelled_before_dispatch')
      OR (close_reason = 'expired_before_dispatch'
          AND NEW."terminalAt" < NEW."deadlineAt")
      OR (close_reason = 'cancelled_before_dispatch'
          AND NEW."terminalAt" >= NEW."deadlineAt")
      OR audit_row."id" IS NULL
      OR audit_row."action" <> 'chat.unified_optimizer.queued_before_dispatch_terminal'
      OR audit_row."targetType" <> 'ChatUnifiedOptimizerRoleJob'
      OR audit_row."targetId" <> NEW."id"::text
      OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
      OR audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL
      OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR audit_row."metadata"->>'purpose' <> 'provider_free_validation'
      OR audit_row."metadata"->>'role' <> NEW."role"
      OR audit_row."metadata"->>'outcome' <> 'failed'
      OR audit_row."metadata"->>'terminalRequestDigest' <> NEW."terminalRequestDigest"
      OR audit_row."metadata"->>'cycleId' <> run_cycle_id::text
      OR audit_row."metadata"->>'runId' <> NEW."runId"::text
      OR audit_row."metadata"->>'closeRequestDigest' IS NULL
      OR audit_row."metadata"->>'closeRequestDigest' !~ '^[0-9a-f]{64}$'
      OR audit_row."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR audit_row."metadata"->>'paidAuthorized' <> 'false'
      OR audit_row."metadata"->>'promotionAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_queued_terminal_invalid'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" = 'claimed'
    AND NEW."state" IN ('succeeded', 'failed', 'outcome_unknown') THEN
    NEW."terminalAt" := clock_timestamp();
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."terminalAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    IF (NEW."claimRequestId", NEW."claimRequestDigest", NEW."claimToken",
        NEW."claimAuditLogId", NEW."claimedAt") IS DISTINCT FROM
       (OLD."claimRequestId", OLD."claimRequestDigest", OLD."claimToken",
        OLD."claimAuditLogId", OLD."claimedAt")
      OR NEW."terminalRequestId" IS NULL OR NEW."terminalRequestDigest" IS NULL
      OR NEW."terminalOutcome" <> NEW."state"
      OR NEW."terminalAuditLogId" IS NULL
      OR (NEW."state" <> 'outcome_unknown' AND NEW."terminalAt" >= NEW."deadlineAt")
      OR audit_row."id" IS NULL
      OR audit_row."action" <> 'chat.unified_optimizer.run_terminal'
      OR audit_row."targetType" <> 'ChatUnifiedOptimizerRoleJob'
      OR audit_row."targetId" <> NEW."id"::text
      OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
      OR audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL
      OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR audit_row."metadata"->>'purpose' <> 'provider_free_validation'
      OR audit_row."metadata"->>'role' <> NEW."role"
      OR audit_row."metadata"->>'outcome' <> NEW."state"
      OR audit_row."metadata"->>'terminalRequestDigest' <> NEW."terminalRequestDigest"
      OR audit_row."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR audit_row."metadata"->>'paidAuthorized' <> 'false'
      OR audit_row."metadata"->>'promotionAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_terminal_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chat_unified_optimizer_job_transition_invalid' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_evidence_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row "ChatUnifiedOptimizerRoleJob"%ROWTYPE;
  run_row "ChatUnifiedOptimizerRun"%ROWTYPE;
  candidate_row "ChatUnifiedOptimizerCandidate"%ROWTYPE;
  audit_row "AdminAuditLog"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO job_row FROM "ChatUnifiedOptimizerRoleJob"
    WHERE "id" = NEW."jobId";
  SELECT * INTO run_row FROM "ChatUnifiedOptimizerRun"
    WHERE "id" = NEW."runId";
  SELECT * INTO candidate_row FROM "ChatUnifiedOptimizerCandidate"
    WHERE "id" = NEW."candidateId";
  SELECT * INTO audit_row FROM "AdminAuditLog"
    WHERE "id" = NEW."terminalAuditLogId"
      AND xmin = pg_current_xact_id()::xid;
  IF job_row."id" IS NULL OR run_row."id" IS NULL
    OR candidate_row."id" IS NULL OR audit_row."id" IS NULL
    OR job_row."runId" <> NEW."runId"
    OR run_row."cycleId" <> NEW."cycleId"
    OR candidate_row."cycleId" <> NEW."cycleId"
    OR job_row."state" <> NEW."outcome"
    OR job_row."terminalAuditLogId" <> NEW."terminalAuditLogId"
    OR NEW."outcome" NOT IN ('succeeded', 'failed')
    OR audit_row."targetType" <> 'ChatUnifiedOptimizerRoleJob'
    OR audit_row."targetId" <> NEW."jobId"::text
    OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
    OR audit_row."metadata"->>'purpose' <> 'provider_free_validation'
    OR audit_row."metadata"->>'outcome' <> NEW."outcome"
    OR audit_row."metadata"->>'evidenceRef' <> NEW."evidenceRef"
    OR audit_row."metadata"->>'evidencePayloadDigest' <> NEW."payloadDigest" THEN
    RAISE EXCEPTION 'chat_unified_optimizer_evidence_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF audit_row."action" = 'chat.unified_optimizer.run_terminal' THEN
    IF job_row."claimRequestId" IS NULL THEN
      RAISE EXCEPTION 'chat_unified_optimizer_evidence_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF audit_row."action" =
      'chat.unified_optimizer.queued_before_dispatch_terminal' THEN
    IF NEW."outcome" <> 'failed' OR job_row."claimRequestId" IS NOT NULL
      OR audit_row."metadata"->>'closeReason' IS NULL
      OR audit_row."metadata"->>'closeReason' NOT IN
        ('expired_before_dispatch', 'cancelled_before_dispatch')
      OR audit_row."metadata"->>'cycleId' <> NEW."cycleId"::text
      OR audit_row."metadata"->>'runId' <> NEW."runId"::text
      OR audit_row."metadata"->>'closeRequestDigest' IS NULL
      OR audit_row."metadata"->>'closeRequestDigest' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_evidence_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'chat_unified_optimizer_evidence_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "chat_unified_optimizer_queued_closure_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row "ChatUnifiedOptimizerRoleJob"%ROWTYPE;
  run_row "ChatUnifiedOptimizerRun"%ROWTYPE;
  cycle_row "ChatUnifiedOptimizerCycle"%ROWTYPE;
  audit_row "AdminAuditLog"%ROWTYPE;
  evidence_row "ChatUnifiedOptimizerEvidence"%ROWTYPE;
  close_reason TEXT;
  close_digest TEXT;
BEGIN
  IF OLD."state" <> 'queued' OR NEW."state" <> 'failed'
    OR NEW."claimRequestId" IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO job_row FROM "ChatUnifiedOptimizerRoleJob"
    WHERE "id" = NEW."id";
  SELECT * INTO run_row FROM "ChatUnifiedOptimizerRun"
    WHERE "id" = NEW."runId";
  SELECT * INTO cycle_row FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = run_row."cycleId";
  SELECT * INTO audit_row FROM "AdminAuditLog"
    WHERE "id" = NEW."terminalAuditLogId"
      AND xmin = pg_current_xact_id()::xid;
  SELECT * INTO evidence_row FROM "ChatUnifiedOptimizerEvidence"
    WHERE "jobId" = NEW."id"
      AND xmin = pg_current_xact_id()::xid;
  close_reason := audit_row."metadata"->>'closeReason';
  close_digest := audit_row."metadata"->>'closeRequestDigest';
  IF job_row."id" IS NULL OR run_row."id" IS NULL OR cycle_row."id" IS NULL
    OR audit_row."id" IS NULL OR evidence_row."id" IS NULL
    OR job_row."state" <> 'failed' OR job_row."claimRequestId" IS NOT NULL
    OR job_row."terminalRequestId" IS DISTINCT FROM NEW."terminalRequestId"
    OR job_row."terminalRequestDigest" IS DISTINCT FROM NEW."terminalRequestDigest"
    OR job_row."terminalAuditLogId" IS DISTINCT FROM NEW."terminalAuditLogId"
    OR run_row."state" <> 'failed' OR cycle_row."state" <> 'failed'
    OR run_row."cycleId" <> cycle_row."id"
    OR run_row."deadlineAt" IS DISTINCT FROM NEW."deadlineAt"
    OR cycle_row."deadlineAt" IS DISTINCT FROM NEW."deadlineAt"
    OR close_reason IS NULL
    OR close_reason NOT IN ('expired_before_dispatch', 'cancelled_before_dispatch')
    OR close_digest IS NULL OR close_digest !~ '^[0-9a-f]{64}$'
    OR (close_reason = 'expired_before_dispatch'
        AND clock_timestamp() < NEW."deadlineAt")
    OR (close_reason = 'cancelled_before_dispatch'
        AND clock_timestamp() >= NEW."deadlineAt")
    OR audit_row."action" <>
      'chat.unified_optimizer.queued_before_dispatch_terminal'
    OR audit_row."targetType" <> 'ChatUnifiedOptimizerRoleJob'
    OR audit_row."targetId" <> NEW."id"::text
    OR audit_row."metadata"->>'terminalRequestDigest' <>
      NEW."terminalRequestDigest"
    OR audit_row."metadata"->>'cycleId' <> cycle_row."id"::text
    OR audit_row."metadata"->>'runId' <> run_row."id"::text
    OR evidence_row."runId" <> run_row."id"
    OR evidence_row."cycleId" <> cycle_row."id"
    OR evidence_row."terminalAuditLogId" <> audit_row."id"
    OR evidence_row."outcome" <> 'failed'
    OR evidence_row."evidenceRef" <> audit_row."metadata"->>'evidenceRef'
    OR evidence_row."payloadDigest" <>
      audit_row."metadata"->>'evidencePayloadDigest'
    OR EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerRoleJob" j
      WHERE j."runId" = run_row."id"
        AND j."state" IN ('queued', 'claimed', 'outcome_unknown'))
    OR EXISTS (
      SELECT 1
      FROM "ChatUnifiedOptimizerRoleJob" j
      LEFT JOIN "AdminAuditLog" a ON a."id" = j."terminalAuditLogId"
        AND a.xmin = pg_current_xact_id()::xid
      LEFT JOIN "ChatUnifiedOptimizerEvidence" e ON e."jobId" = j."id"
        AND e.xmin = pg_current_xact_id()::xid
      WHERE j."runId" = run_row."id" AND j."state" = 'failed'
        AND (j."claimRequestId" IS NOT NULL
          OR a."id" IS NULL OR e."id" IS NULL
          OR a."action" <>
            'chat.unified_optimizer.queued_before_dispatch_terminal'
          OR a."metadata"->>'closeReason' <> close_reason
          OR a."metadata"->>'closeRequestDigest' <> close_digest)) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_queued_closure_incomplete'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerRoleJob_queued_closure"
AFTER UPDATE ON "ChatUnifiedOptimizerRoleJob"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_queued_closure_guard"();
