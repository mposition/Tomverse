-- Operator decision 2026-11-18 (conversation): an earlier message's extracted
-- attachment text is kept so later turns do not read and parse the file again
-- (docs/policy/user-attachment-persistence.md section 7.1).
--
-- A table of its own, cascaded from "MessageAttachment": deleting the
-- attachment row -- conversation, bulk and account deletion -- deletes this
-- text in the same transaction, so it can never outlive the file. An earlier
-- design stored it as an R2 object beside the file, which no transaction can
-- order against a deletion.
--
-- Rollback: DROP TABLE "MessageAttachmentTextCache"; (a cache: nothing is lost
-- that the next turn cannot extract again).

-- CreateTable
CREATE TABLE "MessageAttachmentTextCache" (
    "attachmentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "entries" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachmentTextCache_pkey" PRIMARY KEY ("attachmentId")
);

-- AddForeignKey
ALTER TABLE "MessageAttachmentTextCache" ADD CONSTRAINT "MessageAttachmentTextCache_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "MessageAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
