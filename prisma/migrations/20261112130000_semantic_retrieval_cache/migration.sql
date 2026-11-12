-- The outcome of one semantic retrieval call (rerank scores, a query vector,
-- or a recorded failure), kept for the minutes a chat context bundle lives
-- (docs/policy/external-conversation-import-and-memory.md section 9a).
--
-- A turn's context is rebuilt on up to three routes and refused when the
-- rebuilt fingerprint differs from the signed one, so the first outcome for a
-- (question, candidates) pair has to be the outcome for every rebuild. The key
-- is a SHA-256; the value holds ids, scores or a vector, never memory or
-- knowledge text. Rows are swept after expiresAt and cascade with the account.
--
-- A new, empty table: nothing is locked that production reads or writes.
--
-- baseline-check: present-if-relation "SemanticRetrievalCache"

-- CreateTable
CREATE TABLE "SemanticRetrievalCache" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SemanticRetrievalCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "SemanticRetrievalCache_expiresAt_idx" ON "SemanticRetrievalCache"("expiresAt");

-- CreateIndex
CREATE INDEX "SemanticRetrievalCache_userId_idx" ON "SemanticRetrievalCache"("userId");

-- AddForeignKey
ALTER TABLE "SemanticRetrievalCache" ADD CONSTRAINT "SemanticRetrievalCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
