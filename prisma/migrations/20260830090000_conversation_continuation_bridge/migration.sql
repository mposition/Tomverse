-- Additive: the bridge row that records a Tomverse conversation started from
-- an imported external conversation.
--
-- Contract: docs/policy/external-conversation-continuation.md.
-- Application copies: lib/externalContinuationSeedCore.ts (seed version),
-- lib/externalImportProviders.ts (provider allowlist).
--
-- Nothing existing changes. No column is added to Conversation, Message,
-- ExternalConversation or ExternalMessage, and no constraint on them is
-- touched, so this deploys safely with the feature flag off and with the code
-- that reads it not yet released (import/memory policy 15).
--
-- ## Why the two foreign keys behave differently
--
-- "conversationId" ON DELETE CASCADE -- the bridge is a fact about that
-- conversation and has no meaning without it.
--
-- "externalConversationId" ON DELETE SET NULL -- deleting the imported source
-- is an unconditional right (import policy 13.1) and it must not take the
-- user's own new messages with it. SET NULL keeps the conversation and its
-- messages exactly where they are.
--
-- SET NULL is also why "sourceDeletedAt" exists. A NULL foreign key on its own
-- reads identically to a bridge whose source was never set, and the screen
-- owes its owner the difference between "there is no original" and "the
-- original was deleted". The deletion service writes the timestamp in the same
-- transaction that removes the source.
--
-- ## Why "conversationId" is UNIQUE
--
-- One bridge per conversation. Two would make "which snapshot is this
-- continuing" a question with two answers, and the seed builder would have to
-- pick one -- which is a decision nobody made.
--
-- Several bridges may point at the same source: forking the same imported
-- conversation more than once is allowed, and each fork is its own
-- conversation.
--
-- ## Why the idempotency key is unique per user and not per source
--
-- It is the identity of one *request*, not of one source. A retried click
-- resolves to the conversation the first attempt created; a second, deliberate
-- fork carries a new key and is a new conversation. Scoping it to the user
-- rather than to the source keeps that true even when the caller reuses a key
-- across sources, which would otherwise create two conversations under one key.
--
-- ## Why the digest is stored and the title is not
--
-- "sourceConversationDigest" identifies the immutable snapshot the user chose
-- (import policy 4.1, 4.2). It is not an access credential, it is never
-- rendered, and it is never logged. The source's title and its message text
-- are deliberately absent: copying them here would put content back into a
-- table that deleting the source does not reach.
--
-- Rollback: DROP TABLE "ConversationContinuationBridge". Nothing else refers
-- to it, and dropping it removes only the provenance -- the conversations and
-- messages it points at are ordinary rows and survive.

CREATE TABLE "ConversationContinuationBridge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalConversationId" TEXT,
    "provider" TEXT NOT NULL,
    "sourceImportedAt" TIMESTAMP(3) NOT NULL,
    "sourceConversationDigest" TEXT NOT NULL,
    "sourceDigestVersion" INTEGER NOT NULL,
    "sourceMessageCount" INTEGER NOT NULL,
    "seedFromOrdinal" INTEGER NOT NULL,
    "seedToOrdinal" INTEGER NOT NULL,
    "seedMessageCount" INTEGER NOT NULL,
    "seedTruncatedMessageCount" INTEGER NOT NULL,
    "seedOmittedMessageCount" INTEGER NOT NULL,
    "contextSeedVersion" TEXT NOT NULL,
    "sourceDeletedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationContinuationBridge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationContinuationBridge_conversationId_key"
    ON "ConversationContinuationBridge"("conversationId");

CREATE UNIQUE INDEX "ConversationContinuationBridge_userId_idempotencyKey_key"
    ON "ConversationContinuationBridge"("userId", "idempotencyKey");

CREATE INDEX "ConversationContinuationBridge_userId_createdAt_idx"
    ON "ConversationContinuationBridge"("userId", "createdAt");

CREATE INDEX "ConversationContinuationBridge_externalConversationId_idx"
    ON "ConversationContinuationBridge"("externalConversationId");

ALTER TABLE "ConversationContinuationBridge"
    ADD CONSTRAINT "ConversationContinuationBridge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationContinuationBridge"
    ADD CONSTRAINT "ConversationContinuationBridge_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationContinuationBridge"
    ADD CONSTRAINT "ConversationContinuationBridge_externalConversationId_fkey"
    FOREIGN KEY ("externalConversationId") REFERENCES "ExternalConversation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The same allowlist ExternalImport and ExternalConversation carry. SQL cannot
-- import TypeScript, so this is a copy and npm run check:enum-constraints is
-- what holds it to lib/externalImportProviders.ts.
ALTER TABLE "ConversationContinuationBridge"
    ADD CONSTRAINT "ConversationContinuationBridge_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude', 'gemini'));

-- Counts describe a window of the source and cannot be negative, and the
-- window cannot run backwards. Written as CHECKs rather than left to the
-- service because a seed row with 'to' before 'from' would make the disclosure
-- on screen ("messages N to M were used") a sentence with no meaning.
ALTER TABLE "ConversationContinuationBridge"
    ADD CONSTRAINT "ConversationContinuationBridge_seed_window_check"
    CHECK (
        "sourceMessageCount" >= 0
        AND "seedMessageCount" >= 0
        AND "seedTruncatedMessageCount" >= 0
        AND "seedOmittedMessageCount" >= 0
        AND "seedFromOrdinal" >= 0
        AND "seedToOrdinal" >= "seedFromOrdinal" - 1
    );
