-- The mirror stops being maintained.
--
-- Contract: docs/policy/email-notifications.md v26,
-- docs/policy/email-product-news-redesign-draft.md section 7.4 (deploy C).
--
-- 20260916150000 added `SuppressionCause` beside `SuppressionEntry` and a
-- trigger that carried every entry write into a cause, so that a build reading
-- either table saw the same suppressions. Deploy B switched the read authority
-- to causes; both environments made that switch on 2026-09-17. This deploy
-- stops the application writing entries at all, and the trigger goes with those
-- writes: with nothing writing the table it has nothing to mirror, and a
-- trigger that fires on a write nobody makes is a mechanism whose absence
-- nobody would notice until it mattered.
--
-- **The table stays.** Dropping it is a separate decision with a separate cost:
-- it is the only record of what the suppression list looked like before causes
-- existed, `SuppressionCause` carries the backfill of it under
-- `legacy:suppression:` keys rather than the rows themselves, and nothing is
-- reading it. An unused table is cheap; an unrecoverable one is not.
--
-- **Order.** This must not reach an environment before the application build
-- that stops writing entries, and that build must not reach one before its
-- cutover to causes has been applied and verified there. An environment still
-- reading entries would, after this, be reading a table that the trigger no
-- longer even keeps consistent with itself -- and the build that goes with this
-- migration refuses to honour that setting for exactly that reason
-- (`EMAIL_SUPPRESSION_AUTHORITY_BELOW_FLOOR`).
--
-- **If it fails and Prisma records it**, replaying is safe: both statements are
-- `IF EXISTS` and neither depends on the other having run.
--
--     SELECT to_regclass('"SuppressionEntry"') AS entry_table,
--            (SELECT count(*) FROM pg_trigger t
--              WHERE t.tgrelid = to_regclass('"SuppressionEntry"')
--                AND t.tgname = 'suppression_entry_to_cause'
--                AND NOT t.tgisinternal) AS trigger_rows,
--            (SELECT count(*) FROM pg_proc p
--               JOIN pg_namespace n ON n.oid = p.pronamespace
--              WHERE p.proname = 'suppression_entry_to_cause'
--                AND n.oid = to_regnamespace(split_part(
--                      to_regclass('"SuppressionEntry"')::text, '.', 1))) AS function_rows;
--
--   * `entry_table` null -> stop. This session is not looking at the schema the
--     migration ran in;
--   * both counts 0 -> it committed: `prisma migrate resolve --applied
--     20260921090000_email_suppression_entry_mirror_dropped`;
--   * either count above 0 -> `prisma migrate resolve --rolled-back ...` and
--     deploy again. Re-running drops whatever is left and does nothing about
--     what is already gone.

BEGIN;

-- The trigger takes ACCESS EXCLUSIVE on `SuppressionEntry` for the moment it
-- runs. Nothing reads that table any more, so the wait is the only cost, and
-- it is bounded rather than left to queue ahead of whatever else is there.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS "suppression_entry_to_cause" ON "SuppressionEntry";

-- And the function it called. Left behind it would be a definition that looks
-- live -- `CREATE OR REPLACE` in the migration above, no trigger anywhere --
-- and the next person to read it would have to work out which.
DROP FUNCTION IF EXISTS "suppression_entry_to_cause"();

COMMIT;
