-- Independent input copies retain their own canonical content. Source edges
-- are nullable so deleting an answer never deletes a user's saved input copy.
ALTER TABLE "MessageArtifact"
  ADD COLUMN "canonicalSpec" JSONB,
  ADD COLUMN "parentArtifactId" TEXT,
  ADD COLUMN "lineageId" TEXT;

ALTER TABLE "MessageAttachmentUpload"
  ADD COLUMN "sourceArtifactId" TEXT,
  ADD COLUMN "sourceLineageId" TEXT,
  ADD COLUMN "sourceConversationId" TEXT,
  ADD COLUMN "sourceCanonicalSpec" JSONB;

ALTER TABLE "MessageAttachment"
  ADD COLUMN "sourceArtifactId" TEXT,
  ADD COLUMN "sourceLineageId" TEXT,
  ADD COLUMN "sourceConversationId" TEXT,
  ADD COLUMN "sourceCanonicalSpec" JSONB;

ALTER TABLE "MessageArtifact"
  ADD CONSTRAINT "MessageArtifact_parentArtifactId_fkey"
    FOREIGN KEY ("parentArtifactId") REFERENCES "MessageArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MessageArtifact_revision_metadata_check" CHECK (
    ("lineageId" IS NULL OR length("lineageId") BETWEEN 1 AND 64)
    AND ("parentArtifactId" IS NULL OR ("parentArtifactId" <> "id" AND "lineageId" IS NOT NULL))
    AND ("canonicalSpec" IS NULL OR (
      "format" = 'xlsx' AND "status" = 'ready'
      AND jsonb_typeof("canonicalSpec") = 'object'
      AND COALESCE("canonicalSpec"->>'version' = '1', false)
      AND COALESCE("canonicalSpec"->>'kind' = 'spreadsheet', false)
      AND COALESCE(jsonb_typeof("canonicalSpec"->'spec') = 'object', false)
      AND octet_length("canonicalSpec"::text) <= 5242880
    ))
  );

ALTER TABLE "MessageAttachmentUpload"
  ADD CONSTRAINT "MessageAttachmentUpload_sourceArtifactId_fkey"
    FOREIGN KEY ("sourceArtifactId") REFERENCES "MessageArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MessageAttachmentUpload_revision_metadata_check" CHECK (
    (("sourceLineageId" IS NULL AND "sourceConversationId" IS NULL AND "sourceArtifactId" IS NULL AND "sourceCanonicalSpec" IS NULL)
      OR ("sourceLineageId" IS NOT NULL AND "sourceConversationId" IS NOT NULL AND length("sourceLineageId") BETWEEN 1 AND 64 AND length("sourceConversationId") BETWEEN 1 AND 64))
    AND ("sourceCanonicalSpec" IS NULL OR (
      jsonb_typeof("sourceCanonicalSpec") = 'object'
      AND COALESCE("sourceCanonicalSpec"->>'version' = '1', false)
      AND COALESCE("sourceCanonicalSpec"->>'kind' = 'spreadsheet', false)
      AND COALESCE(jsonb_typeof("sourceCanonicalSpec"->'spec') = 'object', false)
      AND octet_length("sourceCanonicalSpec"::text) <= 5242880
    ))
  );

ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_sourceArtifactId_fkey"
    FOREIGN KEY ("sourceArtifactId") REFERENCES "MessageArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MessageAttachment_revision_metadata_check" CHECK (
    (("sourceLineageId" IS NULL AND "sourceConversationId" IS NULL AND "sourceArtifactId" IS NULL AND "sourceCanonicalSpec" IS NULL)
      OR ("sourceLineageId" IS NOT NULL AND "sourceConversationId" IS NOT NULL AND length("sourceLineageId") BETWEEN 1 AND 64 AND length("sourceConversationId") BETWEEN 1 AND 64))
    AND ("sourceCanonicalSpec" IS NULL OR (
      jsonb_typeof("sourceCanonicalSpec") = 'object'
      AND COALESCE("sourceCanonicalSpec"->>'version' = '1', false)
      AND COALESCE("sourceCanonicalSpec"->>'kind' = 'spreadsheet', false)
      AND COALESCE(jsonb_typeof("sourceCanonicalSpec"->'spec') = 'object', false)
      AND octet_length("sourceCanonicalSpec"::text) <= 5242880
    ))
  );

CREATE INDEX "MessageArtifact_userId_conversationId_lineageId_createdAt_idx" ON "MessageArtifact"("userId", "conversationId", "lineageId", "createdAt");
CREATE INDEX "MessageArtifact_parentArtifactId_idx" ON "MessageArtifact"("parentArtifactId");
CREATE INDEX "MessageAttachment_sourceArtifactId_idx" ON "MessageAttachment"("sourceArtifactId");
CREATE INDEX "MessageAttachmentUpload_sourceArtifactId_idx" ON "MessageAttachmentUpload"("sourceArtifactId");
