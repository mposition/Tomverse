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
-- **Order.** The condition is not "the application first". It is:
--
--   1. the cutover to causes has been applied and verified in this
--      environment; and
--   2. every build that can still write here writes causes directly.
--
-- (2) is what actually matters, and it is not the same as "the new build has
-- been deployed". Every build since deploy A writes the cause itself -- the
-- trigger was for a build older than that -- so this migration is safe before
-- or after the application that stops writing entries. What is *not* safe is a
-- rolling deploy with one instance old enough to write only the entry: it would
-- write a suppression that, with the trigger gone, becomes no cause at all, and
-- the send path reads causes.
--
-- An environment whose setting still says `entry` is a separate problem, and
-- the build that goes with this migration refuses to honour it rather than
-- reading a table nothing maintains (`EMAIL_SUPPRESSION_AUTHORITY_BELOW_FLOOR`).
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
--              WHERE p.proname = 'suppression_entry_to_cause'
--                AND p.pronargs = 0
--                AND p.pronamespace = (SELECT c.relnamespace FROM pg_class c
--                                       WHERE c.oid = to_regclass('"SuppressionEntry"')))
--              AS function_rows;
--
-- The function's schema is read from the table's `relnamespace` rather than
-- from the text of its `regclass`. A relation that is visible on the search
-- path prints without a schema -- `SuppressionEntry`, not `public.…` -- so
-- taking the part before the first dot yields the *table's own name*, and
-- `to_regnamespace` of that is null. The count would then be 0 whatever is
-- there, which is the reading that says "it committed".
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
