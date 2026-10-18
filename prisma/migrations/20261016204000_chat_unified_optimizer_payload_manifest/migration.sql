-- Bind each cost/quota reservation to the exact payload manifest that a later,
-- separately authorised dispatcher may use. Existing rows cannot be assigned a
-- trustworthy manifest after the fact, so this intentionally fails closed when
-- the pre-feature table is not empty.
ALTER TABLE "ChatUnifiedOptimizerDispatchHold"
  ADD COLUMN "payloadManifestDigest" TEXT NOT NULL;

ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT
  "ChatUnifiedOptimizerDispatchHold_payload_manifest_check" CHECK (
    "payloadManifestDigest" ~ '^[0-9a-f]{64}$'
  );

CREATE FUNCTION "chat_unified_optimizer_payload_manifest_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserve_audit "AdminAuditLog"%ROWTYPE;
DECLARE intent_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO reserve_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."reservationAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    SELECT * INTO intent_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."intentAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    IF reserve_audit."id" IS NULL
      OR reserve_audit."action" <> 'chat.unified_optimizer.call_reserved'
      OR reserve_audit."targetType" <> 'ChatUnifiedOptimizerDispatchHold'
      OR reserve_audit."targetId" <> NEW."id"::text
      OR reserve_audit."actorUserId" IS NOT NULL
      OR reserve_audit."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR reserve_audit."metadata"->>'payloadManifestDigest' <>
        NEW."payloadManifestDigest"
      OR reserve_audit."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR intent_audit."id" IS NULL
      OR intent_audit."action" <>
        'chat.unified_optimizer.call_dispatch_intended'
      OR intent_audit."targetType" <> 'ChatUnifiedOptimizerDispatchHold'
      OR intent_audit."targetId" <> NEW."id"::text
      OR intent_audit."actorUserId" IS NOT NULL
      OR intent_audit."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR intent_audit."metadata"->>'payloadManifestDigest' <>
        NEW."payloadManifestDigest"
      OR intent_audit."metadata"->>'externalDispatchAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_payload_manifest_invalid'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."payloadManifestDigest" IS DISTINCT FROM OLD."payloadManifestDigest" THEN
    RAISE EXCEPTION 'chat_unified_optimizer_payload_manifest_immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerDispatchHold_payload_manifest_guard"
BEFORE INSERT OR UPDATE ON "ChatUnifiedOptimizerDispatchHold"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_payload_manifest_guard"();

-- The application checks these boundaries before it records an intent. This
-- deferred trigger checks them again against the database clock at COMMIT so a
-- transaction waiting behind a lock cannot commit a newly stale intent. It is
-- INSERT-only: known and unknown terminal facts remain recordable after expiry.
CREATE FUNCTION "chat_unified_optimizer_dispatch_intent_fresh_at_commit"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary_invalid BOOLEAN;
BEGIN
  SELECT
    p."state" <> 'active'
    OR cr."state" <> 'active'
    OR r."state" <> 'succeeded'
    OR c."state" <> 'succeeded'
    OR j."state" <> 'succeeded'
    OR c."externalDispatchAuthorized" OR c."paidAuthorized"
    OR r."externalDispatchAuthorized" OR r."paidAuthorized"
    OR j."externalDispatchAuthorized" OR j."paidAuthorized"
    OR h."externalDispatchAuthorized"
    OR clock_timestamp() >= r."deadlineAt"
    OR clock_timestamp() >= j."deadlineAt"
    OR clock_timestamp() >= cc."priceExpiresAt"
    OR clock_timestamp() >= q."provenanceExpiresAt"
    OR clock_timestamp() >= h."preQuotaExpiresAt"
  INTO boundary_invalid
  FROM "ChatUnifiedOptimizerDispatchHold" h
  JOIN "ChatUnifiedOptimizerCostPlan" p ON p."id" = h."planId"
  JOIN "ChatUnifiedOptimizerCostRun" cr ON cr."id" = h."runId"
  JOIN "ChatUnifiedOptimizerCostCall" cc ON cc."id" = h."callBucketId"
  JOIN "ChatUnifiedOptimizerQuotaContract" q
    ON q."id" = cc."quotaContractId"
  JOIN "ChatUnifiedOptimizerRun" r ON r."id" = cr."optimizerRunId"
  JOIN "ChatUnifiedOptimizerCycle" c ON c."id" = r."cycleId"
  JOIN "ChatUnifiedOptimizerRoleJob" j
    ON j."id" = cc."optimizerRoleJobId" AND j."runId" = r."id"
  WHERE h."id" = NEW."id";

  IF boundary_invalid IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'chat_unified_optimizer_dispatch_intent_stale_at_commit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER
  "ChatUnifiedOptimizerDispatchHold_intent_fresh_at_commit"
AFTER INSERT ON "ChatUnifiedOptimizerDispatchHold"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_dispatch_intent_fresh_at_commit"();
