-- External conversation import, Release A storage (A1a).
--
-- Contract: docs/policy/external-conversation-import-and-memory.md §4, §5, §20
-- (status: approved, approvedScopes: RELEASE_A_IMPORT).
--
-- Conversations exported from other AI services never enter "Conversation" /
-- "Message". They live in their own resources so that
--
--   * a provider's model *label* stays provenance metadata and can never be
--     mistaken for a Tomverse runtime modelId,
--   * share/export/billing semantics of native conversations are untouched,
--   * a future MemoryEvidence can reference an immutable source row.
--
-- Two invariants are enforced here rather than in application code:
--
--   * "ExternalConversation_userId_conversationDigest_key" — a conversation
--     digest is server-recomputed over the normalized content (§4.1); the
--     unique index is the backstop that makes an exact re-import a duplicate
--     *conflict* instead of a silent second copy. A changed export of the
--     same source becomes a NEW row (new digest, same externalStableId):
--     snapshots are immutable and are never merged into (§4.2).
--   * "ExternalMessage_externalConversationId_ordinal_key" — one message per
--     ordinal; a partially re-sent batch cannot interleave a second copy.
--
-- The CHECK constraints below cannot be expressed in schema.prisma (same
-- situation as the ten baseline CHECKs — see docs/ops/migration-baseline.md);
-- scripts/compare-schema-to-migrations.mjs is what keeps them honest.
-- CreateTable
CREATE TABLE "ExternalImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inspecting',
    "clientFingerprint" TEXT,
    "importDigest" TEXT,
    "digestVersion" INTEGER NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "sourceFormatVersion" TEXT,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "normalizedBytes" BIGINT NOT NULL DEFAULT 0,
    "truncationCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalStableId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceModelLabels" JSONB,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "conversationDigest" TEXT NOT NULL,
    "digestVersion" INTEGER NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "contentBytes" BIGINT NOT NULL,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "externalStableId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "originalContentDigest" TEXT,
    "digestVersion" INTEGER NOT NULL,
    "sourceModelLabel" TEXT,
    "sourceTimestamp" TIMESTAMP(3),
    "ordinal" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "originalCharacterCount" INTEGER,
    "retainedCharacterCount" INTEGER,

    CONSTRAINT "ExternalMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalImport_userId_status_idx" ON "ExternalImport"("userId", "status");

-- CreateIndex
CREATE INDEX "ExternalImport_userId_createdAt_idx" ON "ExternalImport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalImport_status_updatedAt_idx" ON "ExternalImport"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ExternalConversation_userId_externalStableId_idx" ON "ExternalConversation"("userId", "externalStableId");

-- CreateIndex
CREATE INDEX "ExternalConversation_userId_finalized_idx" ON "ExternalConversation"("userId", "finalized");

-- CreateIndex
CREATE INDEX "ExternalConversation_importId_idx" ON "ExternalConversation"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalConversation_userId_conversationDigest_key" ON "ExternalConversation"("userId", "conversationDigest");

-- CreateIndex
CREATE INDEX "ExternalMessage_userId_idx" ON "ExternalMessage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMessage_externalConversationId_ordinal_key" ON "ExternalMessage"("externalConversationId", "ordinal");

-- AddForeignKey
ALTER TABLE "ExternalImport" ADD CONSTRAINT "ExternalImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalConversation" ADD CONSTRAINT "ExternalConversation_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ExternalImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMessage" ADD CONSTRAINT "ExternalMessage_externalConversationId_fkey" FOREIGN KEY ("externalConversationId") REFERENCES "ExternalConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Only normalized user/assistant text is ever imported (§5.6). system /
-- developer / tool / reasoning content must be dropped by the adapter, and a
-- row that claims otherwise is a bug worth failing loudly on.
ALTER TABLE "ExternalMessage"
    ADD CONSTRAINT "ExternalMessage_role_check"
    CHECK ("role" IN ('user', 'assistant'));

-- Release A supports exactly these providers; Gemini arrives as its own
-- release (A2) with its own parser, fixtures and migration (§1).
ALTER TABLE "ExternalImport"
    ADD CONSTRAINT "ExternalImport_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude'));

ALTER TABLE "ExternalConversation"
    ADD CONSTRAINT "ExternalConversation_provider_check"
    CHECK ("provider" IN ('chatgpt', 'claude'));

-- The import status set is the §20 state machine; an unknown status would be
-- invisible to the staging-TTL sweep and could leak staged content past its
-- 24h/72h lifetime (§5.5).
ALTER TABLE "ExternalImport"
    ADD CONSTRAINT "ExternalImport_status_check"
    CHECK ("status" IN ('inspecting', 'staging', 'preview_ready', 'finalizing', 'completed', 'failed', 'cancelled'));

-- A truncated message without its pre-truncation digest and both character
-- counts has lost the only trace of the unretained content (§5.4) — the
-- column combination is meaningless and must not be storable.
ALTER TABLE "ExternalMessage"
    ADD CONSTRAINT "ExternalMessage_truncation_check"
    CHECK (
        ("truncated" = false AND "originalContentDigest" IS NULL)
        OR (
            "truncated" = true
            AND "originalContentDigest" IS NOT NULL
            AND "originalCharacterCount" IS NOT NULL
            AND "retainedCharacterCount" IS NOT NULL
            AND "originalCharacterCount" >= "retainedCharacterCount"
            AND "retainedCharacterCount" >= 0
        )
    );

ALTER TABLE "ExternalMessage"
    ADD CONSTRAINT "ExternalMessage_ordinal_check"
    CHECK ("ordinal" >= 0);

-- digestVersion identifies the canonicalization contract of
-- lib/externalImportDigest.ts; zero or negative would mean "no contract".
ALTER TABLE "ExternalImport"
    ADD CONSTRAINT "ExternalImport_digestVersion_check"
    CHECK ("digestVersion" >= 1);

ALTER TABLE "ExternalConversation"
    ADD CONSTRAINT "ExternalConversation_digestVersion_check"
    CHECK ("digestVersion" >= 1);

ALTER TABLE "ExternalMessage"
    ADD CONSTRAINT "ExternalMessage_digestVersion_check"
    CHECK ("digestVersion" >= 1);
