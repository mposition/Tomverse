-- The plain index the unique one replaced.
--
-- Contract: docs/policy/email-notifications.md v24.
--
-- `EmailDelivery(providerAccount, providerMessageId)` was indexed for the
-- webhook matcher; 20260920100000 made the same pair unique, which answers the
-- same question with a guarantee. Two structures for one question is how they
-- drift apart, so the plain one goes.
--
-- **Its own migration, on purpose.** Dropping it needs ACCESS EXCLUSIVE on
-- `EmailDelivery`. Asking for that inside 20260920100000, which already holds
-- SHARE on the same table from the index build, would hold the table shut from
-- the start of a long build rather than for one catalogue edit. Here the lock
-- is asked for on its own, and the worst case of failing is an index nobody
-- uses.
--
-- **If it fails and Prisma records it**, replaying is safe whichever way it
-- went: `DROP INDEX IF EXISTS` does nothing when the index is already gone, so
-- `prisma migrate resolve --rolled-back
-- 20260920100200_email_delivery_drop_redundant_index` followed by another
-- deploy is right both for a lock timeout that dropped nothing and for a lost
-- `COMMIT` reply on a drop that succeeded. That is not this migration being
-- unimportant; it is the statement being idempotent, and it is the reason to
-- leave `IF EXISTS` on a drop that "cannot" fail.

BEGIN;

-- An ACCESS EXCLUSIVE request queues ahead of new readers, so waiting for it
-- stalls the table for everyone. Better to give up and try again at a quieter
-- moment than to hold the door shut.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "EmailDelivery_providerAccount_providerMessageId_idx";

COMMIT;
