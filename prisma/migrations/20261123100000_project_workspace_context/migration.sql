-- Project workspace: a project becomes a context container, not only a folder.
--
-- Additive and expand-only. Every existing ConversationProject keeps
-- contextEnabled = false, so an existing folder keeps behaving as a folder
-- until its owner turns context on. Every existing knowledge file keeps its
-- profile owner, every existing memory stays personal (projectId NULL) and
-- every existing extraction run stays an external-source run.

-- ---------------------------------------------------------------- projects
ALTER TABLE "ConversationProject"
    ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "instructions" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "contextEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "memoryScope" TEXT NOT NULL DEFAULT 'project_only',
    ADD COLUMN "autoMemoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "ConversationProject" ADD CONSTRAINT "ConversationProject_memoryScope_allowed"
    CHECK ("memoryScope" IN ('project_only', 'project_and_personal'));
ALTER TABLE "ConversationProject" ADD CONSTRAINT "ConversationProject_revision_positive"
    CHECK ("revision" >= 1);
-- Input limits on owner-authored text, not retrieval truncation: the whole
-- instruction text is always sent when context is on.
ALTER TABLE "ConversationProject" ADD CONSTRAINT "ConversationProject_description_length"
    CHECK (char_length("description") <= 1000);
ALTER TABLE "ConversationProject" ADD CONSTRAINT "ConversationProject_instructions_length"
    CHECK (char_length("instructions") <= 16000);

-- ------------------------------------------------------ project materials
-- A knowledge file now has exactly one owner container: an assistant profile
-- (every existing row) or a project. The account-level quota still counts
-- both together, so a second container never doubles the storage budget.
ALTER TABLE "AssistantKnowledgeFile" ALTER COLUMN "profileId" DROP NOT NULL;
ALTER TABLE "AssistantKnowledgeFile"
    ADD COLUMN "projectId" TEXT,
    ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'upload',
    ADD COLUMN "sourceRef" JSONB,
    ADD COLUMN "requestKey" TEXT;

ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_one_container"
    CHECK (("profileId" IS NULL) <> ("projectId" IS NULL));
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_sourceKind_allowed"
    CHECK ("sourceKind" IN ('upload', 'note', 'message_attachment', 'generated_artifact', 'review_result', 'research_report'));
-- Copies and notes exist only in projects; an import stages profile files only.
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_project_source_shape"
    CHECK (
        ("projectId" IS NULL AND "sourceKind" = 'upload' AND "sourceRef" IS NULL AND "requestKey" IS NULL)
        OR ("projectId" IS NOT NULL AND "importId" IS NULL)
    );
-- A server-captured copy always records where it came from.
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_copy_has_source"
    CHECK ("sourceKind" IN ('upload', 'note') OR "sourceRef" IS NOT NULL);

-- NO ACTION, not CASCADE: deleting a project must enqueue its objects'
-- tombstones in the same transaction, so a bare DELETE of a project that
-- still holds materials fails instead of orphaning private R2 objects.
ALTER TABLE "AssistantKnowledgeFile" ADD CONSTRAINT "AssistantKnowledgeFile_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "ConversationProject"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "AssistantKnowledgeFile_projectId_createdAt_idx" ON "AssistantKnowledgeFile"("projectId", "createdAt");
-- Retry identity is bound to the target project: the same request key in a
-- different project is a different request.
CREATE UNIQUE INDEX "AssistantKnowledgeFile_projectId_requestKey_key" ON "AssistantKnowledgeFile"("projectId", "requestKey");

ALTER TABLE "AssistantKnowledgeCleanup" DROP CONSTRAINT "AssistantKnowledgeCleanup_reason_allowed";
ALTER TABLE "AssistantKnowledgeCleanup" ADD CONSTRAINT "AssistantKnowledgeCleanup_reason_allowed"
    CHECK ("reason" IN ('file_deleted', 'profile_deleted', 'account_deleted', 'upload_abandoned', 'project_deleted'));

-- ---------------------------------------------------------- project memory
-- NULL = the account's personal memory (every existing row). A value = used
-- only inside that project. CASCADE, never SET NULL: a project's memories must
-- not become personal memories because the project was deleted.
ALTER TABLE "MemoryItem" ADD COLUMN "projectId" TEXT;
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "ConversationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MemoryItem_userId_projectId_status_idx" ON "MemoryItem"("userId", "projectId", "status");

-- The reserved native evidence becomes real: it names a Tomverse message.
-- CASCADE like the external FK; the native source-deletion step classifies
-- the affected memories before a conversation is deleted.
ALTER TABLE "MemoryEvidence" ADD CONSTRAINT "MemoryEvidence_tomverseMessageId_fkey"
    FOREIGN KEY ("tomverseMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MemoryEvidence_tomverseMessageId_idx" ON "MemoryEvidence"("tomverseMessageId");

-- ------------------------------------------------- native extraction runs
ALTER TABLE "MemoryExtractionRun"
    ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'external',
    ADD COLUMN "projectId" TEXT,
    ADD COLUMN "sourceConversationId" TEXT,
    ADD COLUMN "sourceKey" TEXT;
ALTER TABLE "MemoryExtractionRun" ADD CONSTRAINT "MemoryExtractionRun_sourceKind_allowed"
    CHECK ("sourceKind" IN ('external', 'native'));
-- An external run never carries a project; a native run is created with one
-- and its source key. SET NULL on project delete keeps the provider-cost rows
-- the run owns; persistence refuses a native run whose project is gone.
ALTER TABLE "MemoryExtractionRun" ADD CONSTRAINT "MemoryExtractionRun_source_shape"
    CHECK (
        ("sourceKind" = 'external' AND "projectId" IS NULL AND "sourceConversationId" IS NULL AND "sourceKey" IS NULL)
        OR ("sourceKind" = 'native' AND "sourceKey" IS NOT NULL)
    );
ALTER TABLE "MemoryExtractionRun" ADD CONSTRAINT "MemoryExtractionRun_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "ConversationProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- One extraction per native source snapshot.
CREATE UNIQUE INDEX "MemoryExtractionRun_sourceKey_key" ON "MemoryExtractionRun"("sourceKey");
CREATE INDEX "MemoryExtractionRun_sourceConversationId_createdAt_idx" ON "MemoryExtractionRun"("sourceConversationId", "createdAt");

-- ------------------------------------------------- answer source receipts
-- Owner-only record of which project sources an answer was given. Never part
-- of a public share snapshot or a conversation export; opening a source
-- re-checks access, so a receipt grants nothing.
CREATE TABLE "ProjectAnswerReceipt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "sources" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAnswerReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectAnswerReceipt_messageId_key" ON "ProjectAnswerReceipt"("messageId");
CREATE INDEX "ProjectAnswerReceipt_userId_createdAt_idx" ON "ProjectAnswerReceipt"("userId", "createdAt");
ALTER TABLE "ProjectAnswerReceipt" ADD CONSTRAINT "ProjectAnswerReceipt_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAnswerReceipt" ADD CONSTRAINT "ProjectAnswerReceipt_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectAnswerReceipt" ADD CONSTRAINT "ProjectAnswerReceipt_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "ConversationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
