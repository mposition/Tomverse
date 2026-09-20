-- The plain index the contraction's unique one replaced.
--
-- Contract: docs/policy/email-notifications.md v24.
--
-- `EmailDelivery(providerAccount, providerMessageId)` was indexed for the
-- webhook matcher; 20260920100000 made the same pair unique, which answers the
-- same question with a guarantee. Two structures for one question is how they
-- drift apart, so the plain one goes.
--
-- **Its own migration, on purpose.** Dropping it needs ACCESS EXCLUSIVE on
-- `EmailDelivery`, and inside the contraction's transaction that lock would
-- have been requested while SHARE on the same table and ACCESS EXCLUSIVE on
-- `ProviderWebhookEvent` were already held to commit. One long read of
-- `EmailDelivery` outliving the index build would have stalled both tables, and
-- a transaction touching them in the other order could have deadlocked against
-- it -- all for a drop that nothing waits on. Here the lock is asked for on its
-- own, and the worst case of failing is an index nobody uses.
BEGIN;

-- An ACCESS EXCLUSIVE request queues ahead of new readers, so waiting for it
-- stalls the table for everyone. Better to give up and try again at a quieter
-- moment than to hold the door shut.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "EmailDelivery_providerAccount_providerMessageId_idx";

COMMIT;
