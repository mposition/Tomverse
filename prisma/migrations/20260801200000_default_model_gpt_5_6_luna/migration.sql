-- Move the application default model from gpt-5-4-mini to gpt-5-6-luna.
--
-- Scope note, because this migration is deliberately smaller than it looks:
-- it changes what a NEW row defaults to, and realigns one operational
-- setting. It does not rewrite any existing user's chosen default or any
-- existing conversation's model selection. gpt-5-4-mini is still enabled,
-- still publicly listed and still perfectly callable -- it is the baseline
-- the new default is being measured against -- so moving live accounts off
-- it now would be overriding a working, user-visible setting on no evidence.
-- That rewrite is implemented separately and idempotently in
-- scripts/run-default-model-reconciliation.mjs, and is meant to run WITH the
-- retirement deploy, not with this one. See
-- docs/policy/default-model-luna-migration.md.
--
-- Nothing here touches Message.modelId, ChatCreditReservation, UsageBucket or
-- any other settled billing record: historical model ids and their frozen
-- pricing snapshots are never rewritten.

ALTER TABLE "UserSettings"
    ALTER COLUMN "defaultModel" SET DEFAULT 'gpt-5-6-luna';

ALTER TABLE "Conversation"
    ALTER COLUMN "selectedModels" SET DEFAULT '["gpt-5-6-luna"]';

-- The guest lead model.
--
-- This AppSetting key is never seeded -- a row exists only because an
-- administrator set it through the Admin Console -- so it is an admin custom
-- value and is not overwritten wholesale. The single case corrected here is
-- the one this migration itself creates: a row naming gpt-5-4-mini, which
-- lib/appDefaults.ts just removed from GUEST_BRAND_TRIO_MODEL_IDS. A lead
-- model outside the trio is ignored by resolveGuestDefaultSelectedModels, so
-- leaving it would silently demote the setting to a no-op instead of leading
-- with the model that replaced it.
--
-- Any other value (gemini-2-5-flash, claude-haiku-4-5, or a third model an
-- admin picked on purpose) is a live, still-valid choice and is left alone.
-- Guarded on the exact old value, so re-running this changes nothing.
UPDATE "AppSetting"
SET "value" = 'gpt-5-6-luna',
    "updatedAt" = NOW()
WHERE "key" = 'guestDefaultModelId'
  AND "value" = 'gpt-5-4-mini';
