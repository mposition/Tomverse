-- Long-term account memory, Release B storage (slice B1).
--
-- Contract: docs/policy/external-conversation-import-and-memory.md §3, §8,
-- §20, §23 (status: approved, approvedScopes includes RELEASE_B_MEMORY,
-- 2026-08-03).
--
-- Additive on purpose (§15): every flag that could make this schema do
-- anything is off by default, so this migration deploys ahead of the code
-- that uses it and the baseline stays untouched.
--
-- Invariants enforced here rather than in application code:
--
--   * "MemoryEvidence_sourceType_shape_check" — the §8.5 discriminator as
--     settled by the 2026-08-03 amendment: an external_message evidence
--     carries exactly that FK, the reserved tomverse_message shape carries
--     exactly its column, and a manual evidence carries no FK at all but
--     must carry the user-entered grounds text. A row cannot claim one
--     provenance while holding another's reference.
--   * kind/status/sensitivity/mode allowlists — the §8.2/§8.3 vocabulary is
--     closed; an unknown value is a bug, not a forward-compatibility case.
--   * "MemoryItem_confidence_check" — confidence is a [0,1] share, and an
--     out-of-range value would silently distort §9 deterministic scoring.

-- AlterTable (Conversation): per-conversation memory mode (§8.1 invariant 1).
ALTER TABLE "Conversation" ADD COLUMN "memoryMode" TEXT NOT NULL DEFAULT 'inherit';

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_memoryMode_check"
    CHECK ("memoryMode" IN ('inherit', 'on', 'off'));

-- CreateTable
CREATE TABLE "MemoryItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "sensitivity" TEXT NOT NULL DEFAULT 'standard',
    "confidence" DOUBLE PRECISION NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "conflictKey" TEXT,
    "searchTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retrievalVersion" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "userEdited" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "extractionModelId" TEXT,
    "promptVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEvidence" (
    "id" TEXT NOT NULL,
    "memoryItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "externalMessageId" TEXT,
    "tomverseMessageId" TEXT,
    "manualContent" TEXT,
    "evidenceDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryExtractionRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "extractionModelId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "sourceSelection" JSONB NOT NULL,
    "chunkTotal" INTEGER NOT NULL,
    "chunkCompleted" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "pricingVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMemorySettings" (
    "userId" TEXT NOT NULL,
    "masterEnabled" BOOLEAN NOT NULL DEFAULT true,
    "styleEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultConversationMode" TEXT NOT NULL DEFAULT 'on',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMemorySettings_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "MemoryItem_userId_status_idx" ON "MemoryItem"("userId", "status");

-- CreateIndex
CREATE INDEX "MemoryItem_userId_conflictKey_idx" ON "MemoryItem"("userId", "conflictKey");

-- CreateIndex (retrieval v1, §9 — lexical GIN over searchTerms, mirrored by
-- the schema.prisma declaration `type: Gin, ops: ArrayOps` so the drift
-- check sees both sides agree. The table is empty at creation time, so the
-- build does not block production writes.)
CREATE INDEX "MemoryItem_searchTerms_gin_idx" ON "MemoryItem" USING GIN ("searchTerms" array_ops);

-- CreateIndex
CREATE INDEX "MemoryEvidence_memoryItemId_idx" ON "MemoryEvidence"("memoryItemId");

-- CreateIndex
CREATE INDEX "MemoryEvidence_externalMessageId_idx" ON "MemoryEvidence"("externalMessageId");

-- CreateIndex
CREATE INDEX "MemoryEvidence_userId_idx" ON "MemoryEvidence"("userId");

-- CreateIndex
CREATE INDEX "MemoryExtractionRun_userId_status_idx" ON "MemoryExtractionRun"("userId", "status");

-- CreateIndex
CREATE INDEX "MemoryExtractionRun_status_leaseExpiresAt_idx" ON "MemoryExtractionRun"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_memoryItemId_fkey" FOREIGN KEY ("memoryItemId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (cascade keeps Release A's delete paths unblocked; the §13.1
-- source-delete flow and the reconciliation sweep own the memory-state
-- transition for evidence that disappears this way.)
ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_externalMessageId_fkey" FOREIGN KEY ("externalMessageId") REFERENCES "ExternalMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryExtractionRun" ADD CONSTRAINT "MemoryExtractionRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMemorySettings" ADD CONSTRAINT "UserMemorySettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The closed §8.2 kind vocabulary: ten factual kinds, nine style kinds.
ALTER TABLE "MemoryItem"
    ADD CONSTRAINT "MemoryItem_kind_check"
    CHECK ("kind" IN (
        'identity', 'preference', 'occupation', 'expertise',
        'long_term_goal', 'project', 'constraint', 'decision',
        'relationship', 'recurring_context',
        'communication_style', 'tone', 'verbosity', 'structure',
        'formatting', 'language', 'explanation_depth',
        'citation_preference', 'code_style'
    ));

-- The §8.3 state machine, including the two suspension states settled by the
-- 2026-08-03 amendment.
ALTER TABLE "MemoryItem"
    ADD CONSTRAINT "MemoryItem_status_check"
    CHECK ("status" IN (
        'candidate', 'active', 'rejected', 'superseded', 'expired',
        'suspended_by_source_lock', 'suspended_by_source_delete',
        'manual_review_required', 'deleted'
    ));

ALTER TABLE "MemoryItem"
    ADD CONSTRAINT "MemoryItem_sensitivity_check"
    CHECK ("sensitivity" IN ('standard', 'sensitive'));

ALTER TABLE "MemoryItem"
    ADD CONSTRAINT "MemoryItem_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1);

-- §8.5 discriminator shape (2026-08-03 amendment, §23 item 2).
ALTER TABLE "MemoryEvidence"
    ADD CONSTRAINT "MemoryEvidence_sourceType_shape_check"
    CHECK (
        ("sourceType" = 'external_message'
            AND "externalMessageId" IS NOT NULL
            AND "tomverseMessageId" IS NULL
            AND "manualContent" IS NULL)
        OR ("sourceType" = 'tomverse_message'
            AND "tomverseMessageId" IS NOT NULL
            AND "externalMessageId" IS NULL
            AND "manualContent" IS NULL)
        OR ("sourceType" = 'manual'
            AND "externalMessageId" IS NULL
            AND "tomverseMessageId" IS NULL
            AND "manualContent" IS NOT NULL)
    );

ALTER TABLE "MemoryExtractionRun"
    ADD CONSTRAINT "MemoryExtractionRun_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled'));

ALTER TABLE "UserMemorySettings"
    ADD CONSTRAINT "UserMemorySettings_defaultConversationMode_check"
    CHECK ("defaultConversationMode" IN ('on', 'off'));
