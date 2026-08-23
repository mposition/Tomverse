-- User-supplied message attachments: the files a person sent, kept.
--
-- Policy: docs/policy/user-attachment-persistence.md.
--
-- Three tables, and each closes a different hole the previous design had:
--
--   * `MessageAttachment` is the durable record of a file the user attached to
--     one of their own messages. Before it, an attachment lived only in
--     browser memory: it was uploaded, read once by the request that carried
--     it, and lost on reload -- so a file-only turn was stored as a
--     comma-separated list of file names, and no later turn could read the
--     file again.
--   * `MessageAttachmentUpload` is the opaque handle a finalised upload is
--     given. It exists so that no route has to trust a storage key that came
--     from a browser: the client names this row's id, the server resolves the
--     key. It deliberately outlives binding, because a draft can be sent
--     twice and a failed send is retried from the same composer state.
--   * `MessageAttachmentCleanup` is the DB-first deletion tombstone, the same
--     shape and the same reason as `MessageArtifactCleanup`: object storage
--     and Postgres cannot be written in one transaction, so the row's removal
--     enqueues the object's and the maintenance sweep drains the queue.
--
-- CHECK constraints:
--
--   kind        file | text. The server decides it from the media type; a
--               third value would be a kind nothing knows how to read.
--   size        non-negative, and measured in storage rather than declared.
--   reason      the four declared cleanup reasons.
--
-- Backward compatible: every existing Message keeps zero attachments, and a
-- message with none renders exactly as it does today.

CREATE TABLE IF NOT EXISTS "MessageAttachmentUpload" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "boundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageAttachmentUpload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageAttachmentUpload_objectKey_key"
  ON "MessageAttachmentUpload" ("objectKey");
CREATE INDEX IF NOT EXISTS "MessageAttachmentUpload_userId_createdAt_idx"
  ON "MessageAttachmentUpload" ("userId", "createdAt");

ALTER TABLE "MessageAttachmentUpload"
  DROP CONSTRAINT IF EXISTS "MessageAttachmentUpload_kind_check";
ALTER TABLE "MessageAttachmentUpload"
  ADD CONSTRAINT "MessageAttachmentUpload_kind_check"
  CHECK ("kind" IN ('file', 'text'));

ALTER TABLE "MessageAttachmentUpload"
  DROP CONSTRAINT IF EXISTS "MessageAttachmentUpload_size_check";
ALTER TABLE "MessageAttachmentUpload"
  ADD CONSTRAINT "MessageAttachmentUpload_size_check"
  CHECK ("size" >= 0);

ALTER TABLE "MessageAttachmentUpload"
  ADD CONSTRAINT "MessageAttachmentUpload_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MessageAttachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "name" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "size" INTEGER NOT NULL DEFAULT 0,
  "kind" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "uploadId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- One object, one attachment row. Two messages claiming the same stored file
-- would make deletion ambiguous: removing either would enqueue an object the
-- other still needs.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageAttachment_objectKey_key"
  ON "MessageAttachment" ("objectKey");
-- The idempotency key. A re-posted pre-save (a retried fetch, a double
-- submit) writes the same pair and is refused here rather than producing a
-- second card for the same file.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageAttachment_messageId_ordinal_key"
  ON "MessageAttachment" ("messageId", "ordinal");
CREATE INDEX IF NOT EXISTS "MessageAttachment_conversationId_createdAt_idx"
  ON "MessageAttachment" ("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "MessageAttachment_userId_createdAt_idx"
  ON "MessageAttachment" ("userId", "createdAt");

ALTER TABLE "MessageAttachment"
  DROP CONSTRAINT IF EXISTS "MessageAttachment_kind_check";
ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_kind_check"
  CHECK ("kind" IN ('file', 'text'));

ALTER TABLE "MessageAttachment"
  DROP CONSTRAINT IF EXISTS "MessageAttachment_size_check";
ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_size_check"
  CHECK ("size" >= 0);

ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MessageAttachmentCleanup" (
  "id" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MessageAttachmentCleanup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageAttachmentCleanup_objectKey_key"
  ON "MessageAttachmentCleanup" ("objectKey");
CREATE INDEX IF NOT EXISTS "MessageAttachmentCleanup_completedAt_createdAt_idx"
  ON "MessageAttachmentCleanup" ("completedAt", "createdAt");

ALTER TABLE "MessageAttachmentCleanup"
  DROP CONSTRAINT IF EXISTS "MessageAttachmentCleanup_reason_check";
ALTER TABLE "MessageAttachmentCleanup"
  ADD CONSTRAINT "MessageAttachmentCleanup_reason_check"
  CHECK ("reason" IN (
    'conversation_deleted', 'account_deleted', 'message_deleted',
    'upload_abandoned'
  ));
