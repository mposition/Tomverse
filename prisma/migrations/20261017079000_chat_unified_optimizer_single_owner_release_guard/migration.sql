-- Preserve the app reader's one-time owner activation invariant for a live
-- frozen rollback. Replacing this function keeps the existing trigger bound
-- to the same function identity and does not change any stored row.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_frozen_restore_release_ok"()
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
      release_record->>'releaseBindingDigest'
    AND (SELECT COUNT(*) FROM "AdminAuditLog" a
      WHERE a."action" = 'chat.unified_runtime.initial_activated'
        AND a."targetType" = 'ChatUnifiedRouterRefinerRelease'
        AND a."targetId" =
          '0e743d6db68b42c9f0170d774286bac1a35086fb7eb079ae306aa4a59b0095ac') = 1,
    false);
END;
$$;
