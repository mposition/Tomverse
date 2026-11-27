-- Chat personalization and privacy: personal instructions, temporary Chat
-- and answer ratings. Two new tables and one new nullable column; no existing
-- row is rewritten.
--
--   UserPersonalization   what the account owner asked every Chat and Review
--                         answer to know and to follow, and the answer style
--                         they chose (lib/chatPersonalizationCore.ts). One row
--                         per account, deleted with it.
--
--   Conversation."temporaryExpiresAt"
--                         set only on a conversation started as a temporary
--                         Chat, NULL on every other one (and on every row that
--                         exists today). The sweep in
--                         lib/temporaryConversationSweep.ts selects on this
--                         column and nothing else, so a conversation without it
--                         can never be chosen for deletion. The CHECK keeps a
--                         temporary row out of every project and with its
--                         memory off, which is what keeps it out of memory
--                         extraction and memory injection.
--
--   ChatAnswerRating      a signed-in owner's thumbs up or down on one
--                         assistant answer, with the model that answered
--                         copied from the Message row. Deleted with the
--                         answer, the conversation or the account.
--
-- Rollback (nothing else reads these):
--   DROP TABLE "ChatAnswerRating";
--   DROP TABLE "UserPersonalization";
--   ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_temporary_scope_check";
--   DROP INDEX "Conversation_temporaryExpiresAt_idx";
--   ALTER TABLE "Conversation" DROP COLUMN "temporaryExpiresAt";
-- Dropping the column first deletes nothing, but leaves any temporary
-- conversation that still exists as an ordinary one: delete those
-- ("temporaryExpiresAt" IS NOT NULL) through the application first.
BEGIN;

CREATE TABLE "UserPersonalization" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "aboutMe" TEXT NOT NULL DEFAULT '',
    "responsePreferences" TEXT NOT NULL DEFAULT '',
    "responseStyle" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPersonalization_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserPersonalization_responseStyle_check" CHECK ("responseStyle" IN ('default', 'concise', 'detailed', 'formal', 'friendly')),
    CONSTRAINT "UserPersonalization_aboutMe_length_check" CHECK (char_length("aboutMe") <= 1500),
    CONSTRAINT "UserPersonalization_responsePreferences_length_check" CHECK (char_length("responsePreferences") <= 1500)
);

CREATE UNIQUE INDEX "UserPersonalization_userId_key" ON "UserPersonalization"("userId");

ALTER TABLE "UserPersonalization" ADD CONSTRAINT "UserPersonalization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD COLUMN "temporaryExpiresAt" TIMESTAMP(3);

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_temporary_scope_check" CHECK ("temporaryExpiresAt" IS NULL OR ("projectId" IS NULL AND "memoryMode" = 'off'));

CREATE INDEX "Conversation_temporaryExpiresAt_idx" ON "Conversation"("temporaryExpiresAt");

CREATE TABLE "ChatAnswerRating" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "modelId" TEXT,
    "rating" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatAnswerRating_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChatAnswerRating_rating_check" CHECK ("rating" IN ('up', 'down')),
    CONSTRAINT "ChatAnswerRating_reason_check" CHECK ("reason" IS NULL OR "reason" IN ('inaccurate', 'unhelpful', 'incomplete', 'ignored_instructions', 'other')),
    CONSTRAINT "ChatAnswerRating_reason_rating_check" CHECK ("reason" IS NULL OR "rating" = 'down')
);

CREATE UNIQUE INDEX "ChatAnswerRating_messageId_userId_key" ON "ChatAnswerRating"("messageId", "userId");

CREATE INDEX "ChatAnswerRating_userId_conversationId_idx" ON "ChatAnswerRating"("userId", "conversationId");

CREATE INDEX "ChatAnswerRating_modelId_createdAt_idx" ON "ChatAnswerRating"("modelId", "createdAt");

ALTER TABLE "ChatAnswerRating" ADD CONSTRAINT "ChatAnswerRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatAnswerRating" ADD CONSTRAINT "ChatAnswerRating_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatAnswerRating" ADD CONSTRAINT "ChatAnswerRating_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
