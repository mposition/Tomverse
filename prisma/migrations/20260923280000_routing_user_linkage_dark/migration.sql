-- The user column that makes two dark tables data domains in their own right.
--
-- Nothing reads or writes either table, and `npm run check:dark-tables` holds
-- that.
--
-- ---------------------------------------------------------------------------
-- Why a denormalised column rather than a comment
-- ---------------------------------------------------------------------------
--
-- `scripts/check-data-domain-registry.mjs` decides that a table holds user
-- data when the schema gives it a User relation or a `*userId` column. Neither
-- of these had one: `RoutingCandidateVerdict` reaches a person through
-- `RoutingRun` and `DeploymentCacheAffinity` through `Conversation`, and both
-- cascade correctly, but the sweep cannot see it.
--
-- That check is symmetric on purpose. It refuses a registry row for a model
-- the schema does not show holding user data, so hand-registering these was
-- not available: the registry would have been making a claim the schema did
-- not support, which is the drift it exists to stop.
--
-- The repository already answers this, and says so where it does. The registry
-- note beside `RoutingAttempt` and `ContextManifest` reads: "both carry their
-- own userId so they are data domains in their own right rather than child
-- tables nothing grades." These two now do the same.
--
-- Widening the sweep to follow Conversation was the other option and is not
-- this change to make. It is a question about every conversation-linked table
-- in the schema, and the check's own comments record how carefully that rule
-- has been widened before.
--
-- ---------------------------------------------------------------------------
-- Why nullable, and why Cascade
-- ---------------------------------------------------------------------------
--
-- Nullable because a guest has no account row, the same reason
-- `RoutingRun.userId` is nullable. The parent cascade still removes the row
-- when the run or the conversation goes.
--
-- Cascade rather than SetNull for the reason RoutingRun records: what is left
-- after a null userId still names the person. A verdict names the run, and a
-- cache affinity names the conversation, so a surviving row would be a
-- half-anonymisation the registry would have to carry as a gap.
--
-- Rollback: drop the two columns and their foreign keys. Nothing reads them.

ALTER TABLE "RoutingCandidateVerdict"
    ADD COLUMN "userId" TEXT;

ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "RoutingCandidateVerdict_userId_createdAt_idx"
    ON "RoutingCandidateVerdict"("userId", "createdAt")
    WHERE "userId" IS NOT NULL;

ALTER TABLE "DeploymentCacheAffinity"
    ADD COLUMN "userId" TEXT;

ALTER TABLE "DeploymentCacheAffinity"
    ADD CONSTRAINT "DeploymentCacheAffinity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "DeploymentCacheAffinity_userId_lastServedAt_idx"
    ON "DeploymentCacheAffinity"("userId", "lastServedAt")
    WHERE "userId" IS NOT NULL;
