ALTER TABLE "MessageAttachment"
  ADD COLUMN "sourceAttachmentId" TEXT;

ALTER TABLE "MessageAttachment"
  ADD CONSTRAINT "MessageAttachment_sourceAttachmentId_length_check"
  CHECK (
    "sourceAttachmentId" IS NULL OR
    char_length("sourceAttachmentId") BETWEEN 1 AND 64
  );
