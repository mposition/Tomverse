-- A rollout is born inert. The later owner-activation migration must replace
-- this guard with an audited CAS transition; insert cannot skip that boundary.
CREATE FUNCTION "chat_unified_optimizer_canary_prepared_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."phase" IS DISTINCT FROM 'prepared' OR
      NEW."phaseRevision" IS DISTINCT FROM 0 OR
      NEW."canaryStartedAt" IS NOT NULL OR
      NEW."phaseStartedAt" IS NOT NULL OR
      NEW."activationAuditLogId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_insert_must_be_prepared';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "chat_unified_optimizer_canary_prepared_insert_trigger"
BEFORE INSERT ON "ChatUnifiedOptimizerCanaryRollout"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_canary_prepared_insert"();

-- Row-level UPDATE/DELETE guards do not observe TRUNCATE.
CREATE FUNCTION "chat_unified_optimizer_canary_truncate_refused"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001',
    MESSAGE = 'chat_unified_optimizer_canary_rollout_immutable';
END;
$$;

CREATE TRIGGER "chat_unified_optimizer_canary_truncate_refused_trigger"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCanaryRollout"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_canary_truncate_refused"();
