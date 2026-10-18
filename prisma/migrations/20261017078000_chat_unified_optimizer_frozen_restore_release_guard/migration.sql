-- A live rollback to a frozen incumbent must still carry the owner's
-- product release at the database boundary. The application verifies the
-- complete signed release; this guard prevents a direct pointer write from
-- restoring live authority after that release has been removed or changed.
CREATE FUNCTION "chat_unified_optimizer_frozen_restore_release_ok"()
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  release_value TEXT;
  release_record JSONB;
  owner_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT "value" INTO release_value FROM "AppSetting"
    WHERE "key" = 'feature.chatUnifiedRouterRefinerRelease';
  IF release_value IS NULL THEN RETURN false; END IF;
  release_record := release_value::jsonb;
  IF jsonb_typeof(release_record) <> 'object'
     OR (SELECT COUNT(*) FROM jsonb_object_keys(release_record)) <> 4
     OR release_record->>'version' <>
       'chat-unified-router-refiner-release-v1'
     OR release_record->>'status' <> 'active'
     OR release_record->>'activationAuditLogId' IS NULL
     OR release_record->>'releaseBindingDigest' <>
       '0e743d6db68b42c9f0170d774286bac1a35086fb7eb079ae306aa4a59b0095ac' THEN
    RETURN false;
  END IF;
  SELECT * INTO owner_audit FROM "AdminAuditLog"
    WHERE "id" = release_record->>'activationAuditLogId';
  RETURN COALESCE(owner_audit."id" IS NOT NULL
    AND owner_audit."actorUserId" IS NOT NULL
    AND owner_audit."entryHash" IS NOT NULL
    AND owner_audit."action" = 'chat.unified_runtime.initial_activated'
    AND owner_audit."targetType" = 'ChatUnifiedRouterRefinerRelease'
    AND owner_audit."targetId" =
      release_record->>'releaseBindingDigest', false);
END;
$$;

CREATE FUNCTION "chat_unified_optimizer_frozen_restore_release_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."runtimeAuthorized" AND NEW."runtimeAuthorized"
     AND NEW."revision" = OLD."revision" + 1
     AND EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerRollbackReceipt" r
       WHERE r."requestId" = NEW."promotionRequestId"
         AND r."targetKind" = 'active_frozen_bundle')
     AND NOT "chat_unified_optimizer_frozen_restore_release_ok"() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_frozen_restore_release_refused';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerActivePointer_frozen_restore_release_guard"
BEFORE UPDATE ON "ChatUnifiedOptimizerActivePointer"
FOR EACH ROW EXECUTE FUNCTION
  "chat_unified_optimizer_frozen_restore_release_guard"();
