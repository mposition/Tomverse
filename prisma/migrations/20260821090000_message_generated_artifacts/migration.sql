-- Generated artifacts: the files an assistant answer produced.
--
-- Policy: docs/policy/generated-artifacts.md.
--
-- Two tables, and the split is the same one the image feature made for the
-- same reason:
--
--   * `MessageArtifact` is the record that authorises a download. It is
--     cascade-deleted from the message, the conversation and the account, so
--     no deletion path can leave a row that still grants access.
--   * `MessageArtifactCleanup` is the DB-first deletion tombstone. Object
--     storage and Postgres cannot be written in one transaction, so the row's
--     removal enqueues the object's and the fifteen-minute maintenance sweep
--     drains the queue. Storage is never deleted ahead of the database: a
--     partial failure retries from the tombstone instead of leaving rows that
--     point at objects that are gone.
--
-- Three CHECK constraints, each closing a way the application could write a
-- row that promises a file it cannot serve:
--
--   format   the allowlist SUPPORTED_ARTIFACT_FORMATS in
--            lib/generatedArtifactCore.ts. SQL cannot import it, so the copy
--            here is held to that list by
--            tests/integration/generated-artifacts.db.test.ts and registered
--            in scripts/check-enum-constraints.mjs.
--   status   ready | failed. There is no `pending`: a row is written only
--            after the bytes are in storage, so a row that exists and is not
--            `failed` has a file behind it.
--   ready    the pairing between the two. `ready` requires an objectKey and a
--            positive byteSize; `failed` requires neither and must not carry
--            an objectKey, because a failed generation has nothing stored and
--            a key that survived would be a key nothing will ever collect.
--
-- Backward compatible: every existing Message keeps zero artifacts, and a
-- message with none renders exactly as it does today.

CREATE TABLE IF NOT EXISTS "MessageArtifact" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "format" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "objectKey" TEXT,
  "failureCode" TEXT,
  "modelId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageArtifact_objectKey_key"
  ON "MessageArtifact" ("objectKey");
-- The idempotency key. A provider retry that replays the same tool call
-- writes the same pair and is refused here rather than producing a second
-- copy of the same file.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageArtifact_messageId_ordinal_key"
  ON "MessageArtifact" ("messageId", "ordinal");
CREATE INDEX IF NOT EXISTS "MessageArtifact_conversationId_createdAt_idx"
  ON "MessageArtifact" ("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "MessageArtifact_userId_createdAt_idx"
  ON "MessageArtifact" ("userId", "createdAt");

ALTER TABLE "MessageArtifact"
  DROP CONSTRAINT IF EXISTS "MessageArtifact_format_check";
ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_format_check"
  CHECK ("format" IN ('xlsx', 'csv'));

ALTER TABLE "MessageArtifact"
  DROP CONSTRAINT IF EXISTS "MessageArtifact_status_check";
ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_status_check"
  CHECK ("status" IN ('ready', 'failed'));

ALTER TABLE "MessageArtifact"
  DROP CONSTRAINT IF EXISTS "MessageArtifact_ready_has_object_check";
ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_ready_has_object_check"
  CHECK (
    ("status" = 'ready' AND "objectKey" IS NOT NULL AND "byteSize" > 0)
    OR ("status" = 'failed' AND "objectKey" IS NULL)
  );

ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MessageArtifactCleanup" (
  "id" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MessageArtifactCleanup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageArtifactCleanup_objectKey_key"
  ON "MessageArtifactCleanup" ("objectKey");
CREATE INDEX IF NOT EXISTS "MessageArtifactCleanup_completedAt_createdAt_idx"
  ON "MessageArtifactCleanup" ("completedAt", "createdAt");
