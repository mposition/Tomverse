-- Move the application default model from gpt-5-6-luna to gpt-6-luna, and
-- realign the one operational setting the guest trio change strands.
--
-- Same scope as 20260801200000_default_model_gpt_5_6_luna, and for the same
-- reasons: this changes what a NEW row defaults to. It does not rewrite any
-- existing user's chosen default or any existing conversation's model
-- selection. gpt-5-6-luna stays enabled and publicly listed; moving live
-- accounts off a working model is a retirement decision, and that rewrite is
-- scripts/run-default-model-reconciliation.mjs, run with a retirement deploy,
-- never with this one. See docs/policy/default-model-luna-migration.md.
--
-- Nothing here touches Message.modelId, ChatCreditReservation, UsageBucket or
-- any other settled billing record.

ALTER TABLE "UserSettings"
    ALTER COLUMN "defaultModel" SET DEFAULT 'gpt-6-luna';

ALTER TABLE "Conversation"
    ALTER COLUMN "selectedModels" SET DEFAULT '["gpt-6-luna"]';

-- The guest lead model.
--
-- Never seeded: a row exists only because an administrator set it. Two values
-- are corrected, and they are exactly the two this change strands --
-- lib/appDefaults.ts just removed gpt-5-6-luna and claude-haiku-4-5 from
-- GUEST_BRAND_TRIO_MODEL_IDS, and a lead outside the trio is ignored by
-- resolveGuestDefaultSelectedModels. Each moves to the model that replaced it
-- in its own slot. Any other value is a live choice and is left alone.
-- Guarded on the exact old values, so re-running this changes nothing.
UPDATE "AppSetting"
SET "value" = 'gpt-6-luna',
    "updatedAt" = NOW()
WHERE "key" = 'guestDefaultModelId'
  AND "value" = 'gpt-5-6-luna';

UPDATE "AppSetting"
SET "value" = 'claude-haiku-5-5',
    "updatedAt" = NOW()
WHERE "key" = 'guestDefaultModelId'
  AND "value" = 'claude-haiku-4-5';
