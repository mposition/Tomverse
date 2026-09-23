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
-- `EmailDelivery`, and asking for that inside 20260920100000 would hold it
-- until that transaction committed -- so reads of the table would stop from the
-- moment the drop ran until the end of the long index build's transaction,
-- rather than for one catalogue edit. (The build's own SHARE lock does not stop
-- reads; the ACCESS EXCLUSIVE is what does, and it is held to commit like every
-- other lock taken in a transaction.) Here it is asked for on its own, and the
-- worst case of failing is an index nobody uses.
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

-- The same ownership check 20260920100100 makes, for the same reason: this name
-- resolves in the relation namespace with no way to say which table it must
-- belong to, so an index on another table that has taken the name would be
-- dropped instead -- and the drop would *succeed*, leaving nothing to
-- investigate.
DO $ownership$
DECLARE
    owner oid;
BEGIN
    SELECT i.indrelid INTO owner
      FROM pg_index i
     WHERE i.indexrelid = to_regclass('"EmailDelivery_providerAccount_providerMessageId_idx"');

    IF owner IS NOT NULL AND owner IS DISTINCT FROM to_regclass('"EmailDelivery"') THEN
        RAISE EXCEPTION
            'EmailDelivery_providerAccount_providerMessageId_idx belongs to %, not to EmailDelivery; refusing to drop it',
            owner::regclass;
    END IF;
END
$ownership$;

DROP INDEX IF EXISTS "EmailDelivery_providerAccount_providerMessageId_idx";

COMMIT;
