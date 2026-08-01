ALTER TABLE "UserSettings"
    ALTER COLUMN "defaultModel" SET DEFAULT 'gpt-5-4-mini';

ALTER TABLE "Conversation"
    ALTER COLUMN "selectedModels" SET DEFAULT '["gpt-5-4-mini"]';

UPDATE "UserSettings"
SET "defaultModel" = 'gpt-5-4-mini'
WHERE "defaultModel" = 'gpt-4o';

UPDATE "Conversation"
SET "selectedModels" = '["gpt-5-4-mini"]'
WHERE "selectedModels" = '["gpt-4o"]';
