-- "One plan change in flight per account" moves from a partial unique index to
-- a nullable column with a plain unique index.
--
-- The partial index said the right thing, but only to `prisma migrate`. The DB
-- integration suite builds its database with `prisma db push`, which reads
-- schema.prisma and never runs migration SQL -- so the constraint was absent
-- there, the test written to prove it passed nothing, and any other db-push
-- environment silently had no constraint at all.
--
-- `pendingForUserId` carries the account id exactly while the row is pending
-- and null otherwise. Postgres does not compare nulls, so settled rows still
-- accumulate freely while at most one pending row can exist per account -- the
-- same guarantee, in a form schema.prisma can express and both paths create.

ALTER TABLE "PlanChangeRequest" ADD COLUMN "pendingForUserId" TEXT;

-- Backfill before the index exists. No row can violate it: the previous index
-- already held the invariant on every environment this migration reaches.
UPDATE "PlanChangeRequest"
   SET "pendingForUserId" = "userId"
 WHERE "status" = 'pending';

CREATE UNIQUE INDEX "PlanChangeRequest_pendingForUserId_key"
    ON "PlanChangeRequest"("pendingForUserId");

DROP INDEX IF EXISTS "PlanChangeRequest_userId_active_key";
