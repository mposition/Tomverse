-- Record when a credential's referenced secret was rotated and when it expires.
--
-- ADR v2.1 section 12.1 names created_at, last_rotated_at, expires_at and
-- status. created_at and status are already on this table. These two columns
-- are the remaining instants. Both are nullable. A missing instant is not a
-- lifetime this migration chooses, and there is no row to backfill: the table
-- is dark and this statement writes none.
--
-- Rollback: DROP COLUMN "expiresAt", DROP COLUMN "lastRotatedAt", after
-- confirming no runtime source reads them.

ALTER TABLE "CredentialBinding"
ADD COLUMN "lastRotatedAt" TIMESTAMP(3),
ADD COLUMN "expiresAt" TIMESTAMP(3);
