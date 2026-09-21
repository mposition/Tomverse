-- The webhook half of the contraction the account split left owing.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 7.4
-- (C56), docs/policy/email-notifications.md v24.
--
-- 20260917180000 was expand-only: it added `providerAccount`, gave it a default
-- so the build before it could keep inserting without the column, and left the
-- old `(provider, providerEventId)` unique in place so that build's conflict
-- resolution kept working. Both were scaffolding for a rollout that is over --
-- the account-aware build has been live since 2026-09-17 -- and each of them is
-- now a way to be wrong:
--
--   * the old unique refuses a marketing event that happens to carry the same
--     provider event id as a transactional one. They are different events from
--     different accounts, and the account-aware unique is what says so;
--   * the default answers "which account did this come through" with a guess
--     for any writer that forgets to say. There is one writer and it always
--     says, and a default is how that stops being true without anyone noticing.
--
-- **One table.** The `EmailDelivery` half is 20260920100000, and they are
-- separate because together they lock two tables in the opposite order to the
-- webhook handler -- which writes `ProviderWebhookEvent` and then updates
-- `EmailDelivery`. Holding SHARE on one to commit and then asking for ACCESS
-- EXCLUSIVE on the other is a deadlock with any webhook in flight.
--
-- Nothing here can fail on data: both statements are drops, and a drop has no
-- rows to disagree with. What it can fail on is a lock, which is why there is a
-- timeout and why the file is one transaction -- half of this applied is a
-- database whose events name no account *and* have no unique to conflict on.
--
-- **If it fails and Prisma records it**, look at the two objects. The table is
-- named by `to_regclass`, which resolves the bare name the same way the
-- statements below do -- `current_schema()` is the first schema on the search
-- path and need not be the one they resolved to. The column's *existence* is
-- asked separately from its default, because otherwise a table that is not
-- there answers the same as a column with no default, and "both gone" would be
-- indistinguishable from "there is no table here at all":
--
--     SELECT (SELECT ns.nspname || '.' || tb.relname
--               FROM pg_class ix
--               JOIN pg_index i ON i.indexrelid = ix.oid
--               JOIN pg_class tb ON tb.oid = i.indrelid
--               JOIN pg_namespace ns ON ns.oid = tb.relnamespace
--              WHERE ix.oid = to_regclass('"ProviderWebhookEvent_provider_providerEventId_key"'))
--              AS old_unique_on_table,
--            (SELECT count(*) FROM pg_attribute
--              WHERE attrelid = to_regclass('"ProviderWebhookEvent"')
--                AND attname = 'providerAccount'
--                AND NOT attisdropped) AS column_rows,
--            (SELECT pg_get_expr(d.adbin, d.adrelid)
--               FROM pg_attribute a
--               LEFT JOIN pg_attrdef d
--                 ON d.adrelid = a.attrelid AND d.adnum = a.attnum
--              WHERE a.attrelid = to_regclass('"ProviderWebhookEvent"')
--                AND a.attname = 'providerAccount') AS column_default;
--
-- `column_rows` must be 1. If it is 0 the query is looking at the wrong
-- database or schema, and nothing below applies.
--
--   * `old_unique_on_table` ending in `.ProviderWebhookEvent` and a default ->
--     it rolled back: `prisma migrate resolve --rolled-back
--     20260920100100_email_webhook_account_contraction`, then deploy again;
--   * `old_unique_on_table` null and no default -> it committed:
--     `prisma migrate resolve --applied ...`;
--   * one of each -> stop. This file cannot produce that;
--   * `old_unique_on_table` naming **some other table** -> stop, and do not
--     re-run. `DROP INDEX` takes a name and resolves it through the search
--     path; it has no way to say which table the index must belong to. So a
--     replay here would drop that other table's index, and the reading that
--     sent you to replay -- "the old unique is still present" -- would have
--     been about an index this migration never created.
--
-- That last branch is the recovery for a hazard this file shares with every
-- other migration in the repository: an unqualified `DROP INDEX` resolves
-- through the search path, and none of the two hundred migrations here
-- qualifies one. It does not arise from this codebase's own connections --
-- `lib/postgresConnectionConfigCore.mjs` installs `-c search_path=<schema>`, a
-- single schema with no public fallback, so there is one schema to resolve in
-- and `current_schema()` is it. Changing that is a decision about every
-- migration, not about this one.
--
-- **Rollback floor: the commit that introduced 20260917180000** (the
-- account-aware build, live since 2026-09-17). Below it this schema is not
-- merely degraded, it refuses work: that build inserts a webhook event without
-- naming the account and relies on the default this migration drops, so every
-- `ProviderWebhookEvent` insert fails `NOT NULL`, and its conflict handling
-- names `(provider, providerEventId)`, whose unique this migration drops. The
-- cost is every inbound webhook rejected and bounce and complaint handling
-- stopped for the length of the rollback. A rollback that has to go further
-- back than the floor reverts this migration first:
--
--   ALTER TABLE "ProviderWebhookEvent"
--       ALTER COLUMN "providerAccount" SET DEFAULT 'transactional';
--   CREATE UNIQUE INDEX "ProviderWebhookEvent_provider_providerEventId_key"
--       ON "ProviderWebhookEvent"("provider", "providerEventId");
--
-- -- and that CREATE can itself fail, on exactly the cross-account collision
-- the account-aware unique exists to allow. It is a recovery, not a routine.

BEGIN;

-- Both statements take ACCESS EXCLUSIVE on `ProviderWebhookEvent`, which stops
-- reads as well as writes, and an ACCESS EXCLUSIVE request queues ahead of new
-- readers -- so an unbounded wait behind one long query shuts the table for
-- everyone. The statements themselves are catalogue edits and take no time.
SET LOCAL lock_timeout = '5s';

-- The account-aware unique carries every read now
-- (ProviderWebhookEvent_account_event_key, added 20260917180000).
--
-- 20260821090000 line 330 created this with `CREATE UNIQUE INDEX`, so in every
-- database built from this history it is an index and the DROP INDEX below is
-- the statement that removes it. The DROP CONSTRAINT is for a database that got
-- it some other way, and it comes first: if the object were a constraint,
-- `DROP INDEX` would fail on the dependency rather than skip it, and
-- `IF EXISTS` does not cover that.
ALTER TABLE "ProviderWebhookEvent"
    DROP CONSTRAINT IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";

-- Before the drop: this name, if it is anything, has to be an index on
-- `ProviderWebhookEvent`.
--
-- `DROP INDEX` takes a name and resolves it in the relation namespace. It has
-- no way to say which table the index must belong to, and that is not only a
-- multi-schema problem -- in one schema it is enough for the intended index to
-- be gone and for some other table's index to have taken the name. The drop
-- then removes that index and **succeeds**, the migration is recorded as
-- applied, the old unique is still there, and nothing ever runs the recovery
-- query that would have noticed. A branch that only runs after a failure is no
-- help when the failure does not happen.
--
-- So the ownership is checked here, before anything is removed, and a name
-- that belongs to another table aborts the transaction.
DO $ownership$
DECLARE
    owner oid;
BEGIN
    SELECT i.indrelid INTO owner
      FROM pg_index i
     WHERE i.indexrelid = to_regclass('"ProviderWebhookEvent_provider_providerEventId_key"');

    IF owner IS NOT NULL AND owner IS DISTINCT FROM to_regclass('"ProviderWebhookEvent"') THEN
        RAISE EXCEPTION
            'ProviderWebhookEvent_provider_providerEventId_key belongs to %, not to ProviderWebhookEvent; refusing to drop it',
            owner::regclass;
    END IF;
END
$ownership$;

DROP INDEX IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";

-- One writer, and it names the account. A default here would let the next one
-- not name it.
ALTER TABLE "ProviderWebhookEvent" ALTER COLUMN "providerAccount" DROP DEFAULT;

COMMIT;
