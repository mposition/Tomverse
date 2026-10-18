-- A signed, content-free optimizer job gets one durable nonce consumption.
-- This table grants no external dispatch or model-execution authority.
CREATE TABLE "ChatUnifiedOptimizerProtectedHandoff" (
  "intentId" UUID PRIMARY KEY,
  "nonce" UUID NOT NULL UNIQUE,
  "signedPayloadDigest" TEXT NOT NULL,
  "launcherProfileDigest" TEXT NOT NULL,
  "workerGeneration" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "preparedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "consumedAt" TIMESTAMPTZ(3),
  "preparedAuditLogId" TEXT NOT NULL UNIQUE,
  "consumedAuditLogId" TEXT UNIQUE,
  CONSTRAINT "ChatUnifiedOptimizerProtectedHandoff_hold_fkey"
    FOREIGN KEY ("intentId") REFERENCES "ChatUnifiedOptimizerDispatchHold"("intentId")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "ChatUnifiedOptimizerProtectedHandoff_preparedAudit_fkey"
    FOREIGN KEY ("preparedAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "ChatUnifiedOptimizerProtectedHandoff_consumedAudit_fkey"
    FOREIGN KEY ("consumedAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "ChatUnifiedOptimizerProtectedHandoff_shape" CHECK (
    "signedPayloadDigest" ~ '^[0-9a-f]{64}$'
    AND "launcherProfileDigest" ~ '^[0-9a-f]{64}$'
    AND "workerGeneration" > 0
    AND "expiresAt" > "issuedAt"
    AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'
    AND (("state" = 'prepared' AND "consumedAt" IS NULL
      AND "consumedAuditLogId" IS NULL)
      OR ("state" = 'consumed' AND "consumedAt" IS NOT NULL
        AND "consumedAuditLogId" IS NOT NULL))
  )
);

CREATE FUNCTION "chat_unified_optimizer_protected_handoff_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_row "AdminAuditLog"%ROWTYPE;
DECLARE hold_row "ChatUnifiedOptimizerDispatchHold"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_immutable'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO hold_row FROM "ChatUnifiedOptimizerDispatchHold"
    WHERE "intentId" = NEW."intentId";
  IF hold_row."id" IS NULL OR hold_row."reservationRequestId" <> NEW."nonce"
    OR hold_row."state" <> 'dispatch_intended' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_intent_invalid'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."preparedAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    IF NEW."state" <> 'prepared' OR NEW."consumedAt" IS NOT NULL
      OR NEW."consumedAuditLogId" IS NOT NULL
      OR audit_row."id" IS NULL
      OR audit_row."action" <> 'chat.unified_optimizer.protected_job_prepared'
      OR audit_row."targetType" <> 'ChatUnifiedOptimizerProtectedHandoff'
      OR audit_row."targetId" <> NEW."intentId"::text
      OR audit_row."actorUserId" IS NOT NULL
      OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR audit_row."metadata"->>'signedPayloadDigest' <>
        NEW."signedPayloadDigest"
      OR audit_row."metadata"->>'externalDispatchAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_prepare_invalid'
        USING ERRCODE = 'P0001';
    END IF;
    NEW."preparedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'prepared' OR NEW."state" <> 'consumed'
    OR (NEW."intentId", NEW."nonce", NEW."signedPayloadDigest",
        NEW."launcherProfileDigest", NEW."workerGeneration",
        NEW."issuedAt", NEW."expiresAt", NEW."preparedAt",
        NEW."preparedAuditLogId") IS DISTINCT FROM
       (OLD."intentId", OLD."nonce", OLD."signedPayloadDigest",
        OLD."launcherProfileDigest", OLD."workerGeneration",
        OLD."issuedAt", OLD."expiresAt", OLD."preparedAt",
        OLD."preparedAuditLogId")
    OR NEW."consumedAuditLogId" IS NULL THEN
    RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_transition_invalid'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO audit_row FROM "AdminAuditLog"
    WHERE "id" = NEW."consumedAuditLogId"
      AND xmin = pg_current_xact_id()::xid;
  IF audit_row."id" IS NULL
    OR audit_row."action" <> 'chat.unified_optimizer.protected_job_consumed'
    OR audit_row."targetType" <> 'ChatUnifiedOptimizerProtectedHandoff'
    OR audit_row."targetId" <> NEW."intentId"::text
    OR audit_row."actorUserId" IS NOT NULL
    OR audit_row."metadata"->>'systemActor' <> 'chat-unified-optimizer'
    OR audit_row."metadata"->>'signedPayloadDigest' <>
      NEW."signedPayloadDigest"
    OR audit_row."metadata"->>'externalDispatchAuthorized' <> 'false' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_consume_invalid'
      USING ERRCODE = 'P0001';
  END IF;
  NEW."consumedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerProtectedHandoff_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerProtectedHandoff"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_protected_handoff_guard"();

CREATE FUNCTION "chat_unified_optimizer_protected_handoff_fresh_at_commit"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary_invalid BOOLEAN;
BEGIN
  SELECT h."state" <> 'dispatch_intended'
      OR h."externalDispatchAuthorized"
      OR p."state" <> 'active' OR cr."state" <> 'active'
      OR r."state" <> 'succeeded' OR c."state" <> 'succeeded'
      OR j."state" <> 'succeeded'
      OR c."externalDispatchAuthorized" OR c."paidAuthorized"
      OR r."externalDispatchAuthorized" OR r."paidAuthorized"
      OR j."externalDispatchAuthorized" OR j."paidAuthorized"
      OR clock_timestamp() >= NEW."expiresAt"
      OR clock_timestamp() >= r."deadlineAt"
      OR clock_timestamp() >= j."deadlineAt"
      OR clock_timestamp() >= cc."priceExpiresAt"
      OR clock_timestamp() >= q."provenanceExpiresAt"
      OR clock_timestamp() >= h."preQuotaExpiresAt"
      OR EXISTS (SELECT 1 FROM "AppSetting" s
        WHERE s."key"='chat.unified_optimizer.stop_latch.v1')
    INTO boundary_invalid
    FROM "ChatUnifiedOptimizerDispatchHold" h
    JOIN "ChatUnifiedOptimizerCostPlan" p ON p."id"=h."planId"
    JOIN "ChatUnifiedOptimizerCostRun" cr ON cr."id"=h."runId"
    JOIN "ChatUnifiedOptimizerCostCall" cc ON cc."id"=h."callBucketId"
    JOIN "ChatUnifiedOptimizerQuotaContract" q
      ON q."id"=cc."quotaContractId"
    JOIN "ChatUnifiedOptimizerRoleJob" j
      ON j."id"=cc."optimizerRoleJobId"
    JOIN "ChatUnifiedOptimizerRun" r ON r."id"=j."runId"
      AND r."id"=cr."optimizerRunId"
    JOIN "ChatUnifiedOptimizerCycle" c ON c."id"=r."cycleId"
    WHERE h."intentId"=NEW."intentId";
  IF boundary_invalid IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_stale_at_commit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerProtectedHandoff_fresh_at_commit"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerProtectedHandoff"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_protected_handoff_fresh_at_commit"();

CREATE TRIGGER "ChatUnifiedOptimizerProtectedHandoff_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerProtectedHandoff"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();
