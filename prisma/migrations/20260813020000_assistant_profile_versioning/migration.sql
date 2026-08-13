-- Release C1: assistant profiles and their immutable version snapshots.
-- Policy: docs/policy/external-conversation-import-and-memory.md sections 14,
-- 20 (릴리스 C schema), 43 of the delivery prompt.
--
-- Purely additive, and deployable while `assistantProfilesEnabled` is off
-- (§15): two new tables plus one nullable column on Conversation. Nothing
-- reads the column until the flag is on, and NULL is the correct reading for
-- every conversation that already exists -- "this conversation started without
-- a profile".

CREATE TABLE "AssistantProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "description" TEXT,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistantProfileVersion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "toolPolicy" JSONB NOT NULL,
    "memoryPolicy" JSONB NOT NULL,
    "starters" JSONB NOT NULL,
    "knowledgeManifest" JSONB NOT NULL,
    "retrievalVersion" INTEGER NOT NULL,
    "promptFormatVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantProfileVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssistantProfile_currentVersionId_key" ON "AssistantProfile"("currentVersionId");
CREATE INDEX "AssistantProfile_userId_updatedAt_idx" ON "AssistantProfile"("userId", "updatedAt");

-- Revisions are per profile and never reused. This is what makes the stale
-- editor check (`ASSISTANT_PROFILE_VERSION_STALE`, §18) a comparison of two
-- integers rather than of two timestamps, and it is also the concurrency
-- control: two editors publishing from the same revision race on this index,
-- and exactly one insert wins.
CREATE UNIQUE INDEX "AssistantProfileVersion_profileId_revision_key" ON "AssistantProfileVersion"("profileId", "revision");
CREATE INDEX "AssistantProfileVersion_profileId_createdAt_idx" ON "AssistantProfileVersion"("profileId", "createdAt");
-- Ownership is a column, not a join: the account export and the deletion
-- sweep both scope by it, and the data-domain registry reads it as the
-- linkage that makes this table a user-data domain.
CREATE INDEX "AssistantProfileVersion_userId_createdAt_idx" ON "AssistantProfileVersion"("userId", "createdAt");

ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: a version being deleted must not take the profile row
-- with it. In practice versions are never deleted while referenced -- the
-- pointer only moves forward -- but the weaker rule is the safe one here.
ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_currentVersionId_fkey"
    FOREIGN KEY ("currentVersionId") REFERENCES "AssistantProfileVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AssistantProfileVersion" ADD CONSTRAINT "AssistantProfileVersion_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantProfileVersion" ADD CONSTRAINT "AssistantProfileVersion_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A revision is 1-based and monotonic. Without this a bug that wrote 0 or a
-- negative number would make "the newest revision" ambiguous, and the version
-- a conversation pinned is not something to leave to application code alone.
ALTER TABLE "AssistantProfileVersion" ADD CONSTRAINT "AssistantProfileVersion_revision_positive"
    CHECK ("revision" >= 1);

-- Retrieval v1 is lexical (§9, §44). A version claiming a retrieval version
-- the code does not implement is refused at runtime; this stops an impossible
-- one from being stored at all.
ALTER TABLE "AssistantProfileVersion" ADD CONSTRAINT "AssistantProfileVersion_retrievalVersion_positive"
    CHECK ("retrievalVersion" >= 1);

ALTER TABLE "Conversation" ADD COLUMN "assistantProfileVersionId" TEXT;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assistantProfileVersionId_fkey"
    FOREIGN KEY ("assistantProfileVersionId") REFERENCES "AssistantProfileVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
