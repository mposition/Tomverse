-- Attachment availability, and the failure layer that explains an error row.
--
-- Expand only. Every column added here is nullable with no default and no
-- backfill, because NULL is the honest value for every existing row: nothing
-- has checked those objects yet, and a default of "available" would be this
-- migration asserting something it did not look at.
--
-- Rows are never deleted by this feature. An attachment whose bytes a bucket
-- lifecycle rule removed is still an attachment the user sent, and the card,
-- the filename and the size stay in the conversation
-- (docs/policy/user-attachment-persistence.md section 11).
--
-- Rollback: DROP the four columns and the index. No data is moved, so a
-- rollback loses only the availability observations themselves.

ALTER TABLE "MessageAttachment"
  ADD COLUMN IF NOT EXISTS "unavailableAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "unavailableReason" TEXT,
  ADD COLUMN IF NOT EXISTS "availabilityCheckedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "MessageAttachment_unavailableAt_idx"
  ON "MessageAttachment"("unavailableAt");

ALTER TABLE "TraceErrorEvidence"
  ADD COLUMN IF NOT EXISTS "failureLayer" TEXT,
  ADD COLUMN IF NOT EXISTS "storageStatus" INTEGER;
