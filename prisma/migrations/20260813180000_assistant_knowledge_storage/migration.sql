-- Release C2: durable knowledge files, their retrievable chunks, and the
-- tombstone that gets their bytes deleted.
--
-- Policy: docs/policy/external-conversation-import-and-memory.md sections 14,
-- 14.1 (the quota figures), 14.2 (retention and the sweep), 20 (릴리스 C).
--
-- Additive and deployable while `assistantKnowledgeEnabled` is off (§15):
-- three new tables and nothing touched on an existing one.
--
-- No vector column and no embedding table. Retrieval v1 is lexical over
-- searchTerms with a GIN index, exactly as MemoryItem does it, and section 44
-- makes introducing embeddings a separate policy, privacy, cost and eval
-- decision rather than a migration somebody adds in passing.

CREATE TABLE "AssistantKnowledgeFile" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "failureCode" TEXT,
    "extractedCharacters" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "retrievalVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AssistantKnowledgeFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistantKnowledgeChunk" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "searchTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retrievalVersion" INTEGER NOT NULL DEFAULT 1,
    "sourceMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantKnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistantKnowledgeCleanup" (
    "id" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AssistantKnowledgeCleanup_pkey" PRIMARY KEY ("id")
);

-- One object, one row. The cleanup enqueue uses skipDuplicates, so a
-- re-deleted profile or a retried request converges on the same tombstone
-- instead of failing.
CREATE UNIQUE INDEX "AssistantKnowledgeFile_r2Key_key" ON "AssistantKnowledgeFile"("r2Key");
CREATE UNIQUE INDEX "AssistantKnowledgeCleanup_r2Key_key" ON "AssistantKnowledgeCleanup"("r2Key");

CREATE INDEX "AssistantKnowledgeFile_profileId_createdAt_idx" ON "AssistantKnowledgeFile"("profileId", "createdAt");
CREATE INDEX "AssistantKnowledgeFile_userId_createdAt_idx" ON "AssistantKnowledgeFile"("userId", "createdAt");
CREATE INDEX "AssistantKnowledgeFile_processingStatus_createdAt_idx" ON "AssistantKnowledgeFile"("processingStatus", "createdAt");

CREATE UNIQUE INDEX "AssistantKnowledgeChunk_fileId_ordinal_key" ON "AssistantKnowledgeChunk"("fileId", "ordinal");
CREATE INDEX "AssistantKnowledgeChunk_userId_idx" ON "AssistantKnowledgeChunk"("userId");
CREATE INDEX "AssistantKnowledgeCleanup_completedAt_createdAt_idx" ON "AssistantKnowledgeCleanup"("completedAt", "createdAt");

-- Retrieval v1 (§44). The mapped name matches the @@index declaration in
-- schema.prisma so the drift check sees the two agree.
CREATE INDEX "AssistantKnowledgeChunk_searchTerms_gin_idx" ON "AssistantKnowledgeChunk" USING GIN ("searchTerms");

ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantKnowledgeChunk" ADD CONSTRAINT "AssistantKnowledgeChunk_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "AssistantKnowledgeFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantKnowledgeChunk" ADD CONSTRAINT "AssistantKnowledgeChunk_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The processing state machine, in the database rather than only in the code
-- that writes it. A status nobody enumerated is how a file ends up invisible
-- to both the worker (which claims "pending") and retrieval (which reads
-- "ready") while looking fine in a list.
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_processingStatus_allowed"
    CHECK ("processingStatus" IN ('pending', 'processing', 'ready', 'failed'));

-- A failure code belongs to a failure. Without this, a file can be "ready"
-- while carrying the reason it failed, and a reader has two answers.
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_failureCode_matches_status"
    CHECK (("processingStatus" = 'failed') = ("failureCode" IS NOT NULL));

-- Only a processed file has chunks. This is the invariant retrieval depends
-- on, so it is not left to the writer: a "pending" row claiming 40 chunks
-- would be retrieved from before anything had been extracted.
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_chunkCount_requires_ready"
    CHECK ("chunkCount" = 0 OR "processingStatus" = 'ready');

ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_bytes_positive"
    CHECK ("bytes" > 0);
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_chunkCount_non_negative"
    CHECK ("chunkCount" >= 0);
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_retrievalVersion_positive"
    CHECK ("retrievalVersion" >= 1);

ALTER TABLE "AssistantKnowledgeChunk" ADD CONSTRAINT "AssistantKnowledgeChunk_ordinal_non_negative"
    CHECK ("ordinal" >= 0);
ALTER TABLE "AssistantKnowledgeChunk" ADD CONSTRAINT "AssistantKnowledgeChunk_retrievalVersion_positive"
    CHECK ("retrievalVersion" >= 1);

ALTER TABLE "AssistantKnowledgeCleanup" ADD CONSTRAINT "AssistantKnowledgeCleanup_reason_allowed"
    CHECK ("reason" IN ('file_deleted', 'profile_deleted', 'account_deleted', 'upload_abandoned'));
