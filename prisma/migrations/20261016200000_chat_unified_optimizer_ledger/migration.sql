-- Provider-free optimizer metadata ledger. It stores only closed identities,
-- opaque references and lifecycle facts. No candidate body, hidden case,
-- rubric, prompt, provider prose, paid authority or promotion authority enters
-- these tables (docs/policy/chat-unified-router-refiner-v1.md §§7-12).

CREATE TABLE "ChatUnifiedOptimizerCycle" (
  "id" UUID NOT NULL,
  "ledgerVersion" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "registrationRequestId" UUID NOT NULL,
  "registrationDigest" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "externalDispatchAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "paidAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "promotionAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMPTZ(3),
  CONSTRAINT "ChatUnifiedOptimizerCycle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedOptimizerCycle_closed_check" CHECK (
    "ledgerVersion" = 'chat-unified-optimizer-ledger-v1'
    AND "policyVersion" = 1
    AND "purpose" = 'provider_free_validation'
    AND "registrationDigest" ~ '^[0-9a-f]{64}$'
    AND "state" IN ('active', 'succeeded', 'failed', 'outcome_unknown')
    AND NOT "externalDispatchAuthorized"
    AND NOT "paidAuthorized"
    AND NOT "promotionAuthorized"
    AND (("state" = 'active' AND "terminalAt" IS NULL)
      OR ("state" <> 'active' AND "terminalAt" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCycle_registrationRequestId_key"
  ON "ChatUnifiedOptimizerCycle"("registrationRequestId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCycle_one_active_idx"
  ON "ChatUnifiedOptimizerCycle"((1))
  WHERE "state" IN ('active', 'outcome_unknown');
CREATE INDEX "ChatUnifiedOptimizerCycle_state_createdAt_idx"
  ON "ChatUnifiedOptimizerCycle"("state", "createdAt");

CREATE TABLE "ChatUnifiedOptimizerCandidate" (
  "id" UUID NOT NULL,
  "cycleId" UUID NOT NULL,
  "candidateVersion" TEXT NOT NULL,
  "bundleVersion" TEXT NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "bundleDigest" TEXT NOT NULL,
  "controlsDigest" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "stageCandidateDigest" TEXT NOT NULL,
  "adapterConfigDigest" TEXT NOT NULL,
  "pricePinDigest" TEXT NOT NULL,
  "sourceCommitSha" TEXT NOT NULL,
  "runtimeAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedOptimizerCandidate_closed_check" CHECK (
    "candidateVersion" = 'chat-unified-optimizer-candidate-v1'
    AND "bundleVersion" = 'chat-unified-optimizer-bundle-v1'
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND "bundleDigest" ~ '^[0-9a-f]{64}$'
    AND "controlsDigest" ~ '^[0-9a-f]{64}$'
    AND "stageCandidateDigest" ~ '^[0-9a-f]{64}$'
    AND "adapterConfigDigest" ~ '^[0-9a-f]{64}$'
    AND "pricePinDigest" ~ '^[0-9a-f]{64}$'
    AND "sourceCommitSha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND NOT "runtimeAuthorized"
  )
);
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCandidate_cycleId_key"
  ON "ChatUnifiedOptimizerCandidate"("cycleId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCandidate_bundleDigest_key"
  ON "ChatUnifiedOptimizerCandidate"("bundleDigest");
CREATE INDEX "ChatUnifiedOptimizerCandidate_candidateDigest_idx"
  ON "ChatUnifiedOptimizerCandidate"("candidateDigest");

CREATE TABLE "ChatUnifiedOptimizerRun" (
  "id" UUID NOT NULL,
  "cycleId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "externalDispatchAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "paidAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "admissionAuditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMPTZ(3),
  CONSTRAINT "ChatUnifiedOptimizerRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedOptimizerRun_closed_check" CHECK (
    "ordinal" = 1
    AND "purpose" = 'provider_free_validation'
    AND "state" IN ('active', 'succeeded', 'failed', 'outcome_unknown')
    AND NOT "externalDispatchAuthorized"
    AND NOT "paidAuthorized"
    AND (("state" = 'active' AND "terminalAt" IS NULL)
      OR ("state" <> 'active' AND "terminalAt" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRun_cycleId_ordinal_key"
  ON "ChatUnifiedOptimizerRun"("cycleId", "ordinal");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRun_admissionAuditLogId_key"
  ON "ChatUnifiedOptimizerRun"("admissionAuditLogId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRun_one_active_idx"
  ON "ChatUnifiedOptimizerRun"((1))
  WHERE "state" IN ('active', 'outcome_unknown');
CREATE INDEX "ChatUnifiedOptimizerRun_state_createdAt_idx"
  ON "ChatUnifiedOptimizerRun"("state", "createdAt");

CREATE TABLE "ChatUnifiedOptimizerRoleJob" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "externalDispatchAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "paidAuthorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "claimRequestId" UUID,
  "claimRequestDigest" TEXT,
  "claimToken" UUID,
  "claimAuditLogId" TEXT,
  "claimedAt" TIMESTAMPTZ(3),
  "terminalRequestId" UUID,
  "terminalRequestDigest" TEXT,
  "terminalOutcome" TEXT,
  "terminalAuditLogId" TEXT,
  "terminalAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerRoleJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedOptimizerRoleJob_closed_check" CHECK (
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
          AND "terminalAuditLogId" IS NOT NULL AND "terminalAt" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_runId_role_key"
  ON "ChatUnifiedOptimizerRoleJob"("runId", "role");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_claimRequestId_key"
  ON "ChatUnifiedOptimizerRoleJob"("claimRequestId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_claimToken_key"
  ON "ChatUnifiedOptimizerRoleJob"("claimToken");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_claimAuditLogId_key"
  ON "ChatUnifiedOptimizerRoleJob"("claimAuditLogId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_terminalRequestId_key"
  ON "ChatUnifiedOptimizerRoleJob"("terminalRequestId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_terminalAuditLogId_key"
  ON "ChatUnifiedOptimizerRoleJob"("terminalAuditLogId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerRoleJob_one_claimed_idx"
  ON "ChatUnifiedOptimizerRoleJob"((1)) WHERE "state" = 'claimed';
CREATE INDEX "ChatUnifiedOptimizerRoleJob_state_createdAt_idx"
  ON "ChatUnifiedOptimizerRoleJob"("state", "createdAt");

CREATE TABLE "ChatUnifiedOptimizerEvidence" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "cycleId" UUID NOT NULL,
  "candidateId" UUID NOT NULL,
  "outcome" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "terminalAuditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedOptimizerEvidence_closed_check" CHECK (
    "outcome" IN ('succeeded', 'failed')
    AND "evidenceRef" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "payloadDigest" ~ '^[0-9a-f]{64}$'
  )
);
CREATE UNIQUE INDEX "ChatUnifiedOptimizerEvidence_jobId_key"
  ON "ChatUnifiedOptimizerEvidence"("jobId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerEvidence_terminalAuditLogId_key"
  ON "ChatUnifiedOptimizerEvidence"("terminalAuditLogId");
CREATE INDEX "ChatUnifiedOptimizerEvidence_cycleId_createdAt_idx"
  ON "ChatUnifiedOptimizerEvidence"("cycleId", "createdAt");
CREATE INDEX "ChatUnifiedOptimizerEvidence_runId_createdAt_idx"
  ON "ChatUnifiedOptimizerEvidence"("runId", "createdAt");

ALTER TABLE "ChatUnifiedOptimizerCandidate"
  ADD CONSTRAINT "ChatUnifiedOptimizerCandidate_cycleId_fkey"
  FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerRun"
  ADD CONSTRAINT "ChatUnifiedOptimizerRun_cycleId_fkey"
  FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerRun"
  ADD CONSTRAINT "ChatUnifiedOptimizerRun_admissionAuditLogId_fkey"
  FOREIGN KEY ("admissionAuditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerRoleJob"
  ADD CONSTRAINT "ChatUnifiedOptimizerRoleJob_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ChatUnifiedOptimizerRun"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerRoleJob"
  ADD CONSTRAINT "ChatUnifiedOptimizerRoleJob_claimAuditLogId_fkey"
  FOREIGN KEY ("claimAuditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerRoleJob"
  ADD CONSTRAINT "ChatUnifiedOptimizerRoleJob_terminalAuditLogId_fkey"
  FOREIGN KEY ("terminalAuditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerEvidence"
  ADD CONSTRAINT "ChatUnifiedOptimizerEvidence_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ChatUnifiedOptimizerRoleJob"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerEvidence"
  ADD CONSTRAINT "ChatUnifiedOptimizerEvidence_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ChatUnifiedOptimizerRun"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerEvidence"
  ADD CONSTRAINT "ChatUnifiedOptimizerEvidence_cycleId_fkey"
  FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerEvidence"
  ADD CONSTRAINT "ChatUnifiedOptimizerEvidence_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerEvidence"
  ADD CONSTRAINT "ChatUnifiedOptimizerEvidence_terminalAuditLogId_fkey"
  FOREIGN KEY ("terminalAuditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "chat_unified_optimizer_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat_unified_optimizer_immutable' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerCandidate_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerCandidate"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidate_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCandidate"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerEvidence_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerEvidence"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerEvidence_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerEvidence"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();

CREATE FUNCTION "chat_unified_optimizer_cycle_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cycle_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    IF NEW."state" <> 'active' OR NEW."terminalAt" IS NOT NULL
      OR NEW."deadlineAt" <= NEW."createdAt" THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cycle_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'active'
    OR NEW."state" NOT IN ('succeeded', 'failed', 'outcome_unknown')
    OR NEW."terminalAt" IS NULL
    OR (NEW."id", NEW."ledgerVersion", NEW."policyVersion", NEW."purpose",
        NEW."registrationRequestId", NEW."registrationDigest",
        NEW."externalDispatchAuthorized", NEW."paidAuthorized",
        NEW."promotionAuthorized", NEW."deadlineAt", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."ledgerVersion", OLD."policyVersion", OLD."purpose",
        OLD."registrationRequestId", OLD."registrationDigest",
        OLD."externalDispatchAuthorized", OLD."paidAuthorized",
        OLD."promotionAuthorized", OLD."deadlineAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cycle_transition_invalid' USING ERRCODE = 'P0001';
  END IF;
  NEW."terminalAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerCycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerCycle"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cycle_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerCycle_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCycle"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();

CREATE FUNCTION "chat_unified_optimizer_run_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_row "AdminAuditLog"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_run_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."admissionAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    IF NEW."state" <> 'active' OR NEW."terminalAt" IS NOT NULL
      OR NEW."deadlineAt" <= NEW."createdAt"
      OR audit_row."id" IS NULL
      OR audit_row."action" <> 'chat.unified_optimizer.run_admitted'
      OR audit_row."targetType" <> 'ChatUnifiedOptimizerRun'
      OR audit_row."targetId" <> NEW."id"::text
      OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
      OR audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL
      OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR audit_row."metadata"->>'purpose' <> 'provider_free_validation'
      OR audit_row."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR audit_row."metadata"->>'paidAuthorized' <> 'false'
      OR audit_row."metadata"->>'promotionAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_run_admission_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'active'
    OR NEW."state" NOT IN ('succeeded', 'failed', 'outcome_unknown')
    OR NEW."terminalAt" IS NULL
    OR (NEW."id", NEW."cycleId", NEW."ordinal", NEW."purpose",
        NEW."externalDispatchAuthorized", NEW."paidAuthorized",
        NEW."deadlineAt", NEW."admissionAuditLogId", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."cycleId", OLD."ordinal", OLD."purpose",
        OLD."externalDispatchAuthorized", OLD."paidAuthorized",
        OLD."deadlineAt", OLD."admissionAuditLogId", OLD."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_run_transition_invalid' USING ERRCODE = 'P0001';
  END IF;
  NEW."terminalAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerRun_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerRun"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_run_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerRun_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerRun"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();

CREATE FUNCTION "chat_unified_optimizer_job_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_row "AdminAuditLog"%ROWTYPE;
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
CREATE TRIGGER "ChatUnifiedOptimizerRoleJob_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerRoleJob"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_job_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerRoleJob_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerRoleJob"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();

CREATE FUNCTION "chat_unified_optimizer_evidence_guard"()
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
    OR audit_row."action" <> 'chat.unified_optimizer.run_terminal'
    OR audit_row."targetType" <> 'ChatUnifiedOptimizerRoleJob'
    OR audit_row."targetId" <> NEW."jobId"::text
    OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
    OR audit_row."metadata"->>'purpose' <> 'provider_free_validation'
    OR audit_row."metadata"->>'outcome' <> NEW."outcome"
    OR audit_row."metadata"->>'evidenceRef' <> NEW."evidenceRef"
    OR audit_row."metadata"->>'evidencePayloadDigest' <> NEW."payloadDigest" THEN
    RAISE EXCEPTION 'chat_unified_optimizer_evidence_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerEvidence_guard"
BEFORE INSERT ON "ChatUnifiedOptimizerEvidence"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_evidence_guard"();

-- At commit, every registration is complete and every aggregate state is the
-- exact result of its role jobs. This also makes direct partial SQL writes fail.
CREATE FUNCTION "chat_unified_optimizer_ledger_complete"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_cycle UUID;
  cycle_row "ChatUnifiedOptimizerCycle"%ROWTYPE;
  run_row "ChatUnifiedOptimizerRun"%ROWTYPE;
  candidate_count INTEGER;
  run_count INTEGER;
  role_count INTEGER;
  success_count INTEGER;
  failed_count INTEGER;
  unknown_count INTEGER;
  roles TEXT[];
  expected_state TEXT;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerCycle' THEN
    target_cycle := NEW."id";
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerCandidate' THEN
    target_cycle := NEW."cycleId";
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerRun' THEN
    target_cycle := NEW."cycleId";
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerRoleJob' THEN
    SELECT "cycleId" INTO target_cycle FROM "ChatUnifiedOptimizerRun"
      WHERE "id" = NEW."runId";
  ELSE
    target_cycle := NEW."cycleId";
  END IF;
  SELECT * INTO cycle_row FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = target_cycle;
  SELECT COUNT(*) INTO candidate_count FROM "ChatUnifiedOptimizerCandidate"
    WHERE "cycleId" = target_cycle;
  SELECT COUNT(*) INTO run_count FROM "ChatUnifiedOptimizerRun"
    WHERE "cycleId" = target_cycle;
  SELECT * INTO run_row FROM "ChatUnifiedOptimizerRun"
    WHERE "cycleId" = target_cycle AND "ordinal" = 1;
  IF cycle_row."id" IS NULL OR candidate_count <> 1 OR run_count <> 1
    OR run_row."id" IS NULL
    OR cycle_row."deadlineAt" IS DISTINCT FROM run_row."deadlineAt" THEN
    RAISE EXCEPTION 'chat_unified_optimizer_registration_incomplete' USING ERRCODE = 'P0001';
  END IF;
  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE "state" = 'succeeded'),
    COUNT(*) FILTER (WHERE "state" = 'failed'),
    COUNT(*) FILTER (WHERE "state" = 'outcome_unknown'),
    array_agg("role" ORDER BY "role")
  INTO role_count, success_count, failed_count, unknown_count, roles
  FROM "ChatUnifiedOptimizerRoleJob" WHERE "runId" = run_row."id";
  IF role_count <> 6 OR roles IS DISTINCT FROM ARRAY[
      'candidate_author', 'case_author', 'case_reviewer', 'coordinator',
      'judge_primary', 'judge_secondary']::TEXT[]
    OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerRoleJob"
      WHERE "runId" = run_row."id"
        AND "deadlineAt" IS DISTINCT FROM run_row."deadlineAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_roles_incomplete' USING ERRCODE = 'P0001';
  END IF;
  expected_state := CASE
    WHEN unknown_count > 0 THEN 'outcome_unknown'
    WHEN failed_count > 0 THEN 'failed'
    WHEN success_count = 6 THEN 'succeeded'
    ELSE 'active'
  END;
  IF run_row."state" <> expected_state OR cycle_row."state" <> expected_state THEN
    RAISE EXCEPTION 'chat_unified_optimizer_aggregate_state_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerRoleJob" j
    WHERE j."runId" = run_row."id"
      AND ((j."state" IN ('succeeded', 'failed') AND NOT EXISTS (
            SELECT 1 FROM "ChatUnifiedOptimizerEvidence" e
            WHERE e."jobId" = j."id" AND e."outcome" = j."state"))
        OR (j."state" = 'outcome_unknown' AND EXISTS (
            SELECT 1 FROM "ChatUnifiedOptimizerEvidence" e
            WHERE e."jobId" = j."id")))) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_terminal_evidence_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCycle_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerCycle"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_ledger_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCandidate_complete"
AFTER INSERT ON "ChatUnifiedOptimizerCandidate"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_ledger_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerRun_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_ledger_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerRoleJob_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerRoleJob"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_ledger_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerEvidence_complete"
AFTER INSERT ON "ChatUnifiedOptimizerEvidence"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_ledger_complete"();
