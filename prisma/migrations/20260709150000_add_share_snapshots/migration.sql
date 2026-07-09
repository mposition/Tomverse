ALTER TABLE "Conversation"
    ADD COLUMN "shareSnapshot" JSONB,
    ADD COLUMN "shareExpiresAt" TIMESTAMP(3),
    ADD COLUMN "shareRevokedAt" TIMESTAMP(3);

UPDATE "Conversation"
SET
    "shareEnabled" = false,
    "shareToken" = NULL,
    "shareRevokedAt" = CURRENT_TIMESTAMP
WHERE "shareEnabled" = true;
