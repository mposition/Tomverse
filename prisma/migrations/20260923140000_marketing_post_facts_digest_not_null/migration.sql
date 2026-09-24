-- `MarketingPost.factsDigest` becomes NOT NULL.
--
-- Authority: the S2 plan's "S2b3 — factsDigest migration". The column arrived
-- nullable in 20260921170000_marketing_post_facts_digest because an expand
-- migration cannot write a value for rows that already exist. Every writer
-- since has set it from the sealed decision, so the nullability is for rows
-- that predate the column, not for rows anyone still makes.
--
-- What was read, and when. On 2026-09-23 production answered
-- `relation "MarketingPost" does not exist`: both marketing migrations are on
-- `develop` and neither has reached `main`, so when they arrive the table is
-- created at whatever the schema says then and there is no legacy population
-- to dispose of. Staging, read the same day, holds zero rows altogether.
--
-- That was true of those databases as they were read, and this file does not
-- rely on it staying true. The Guard pipeline can write drafts into staging
-- between that reading and this migration running, and a row with no digest is
-- a row whose Guard decision nobody can reconstruct -- which is a decision for
-- a person, not something to infer here. So the count is taken again, at apply
-- time, against the database actually in front of it, and a non-zero answer
-- stops the migration with the number in the message.
--
-- Recovering from that stop is deliberately not automated. `npm run
-- report:marketing-facts-digest` says what those rows are -- how many are
-- still live, how many are under legal hold -- and the disposition is the
-- operator's, carried out separately, before this migration is run again.

DO $$
DECLARE
    missing bigint;
BEGIN
    SELECT count(*) INTO missing
    FROM "MarketingPost"
    WHERE "factsDigest" IS NULL;

    IF missing > 0 THEN
        RAISE EXCEPTION
            'MarketingPost has % row(s) with no factsDigest; run npm run report:marketing-facts-digest and decide a disposition before this migration', missing
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

ALTER TABLE "MarketingPost" ALTER COLUMN "factsDigest" SET NOT NULL;
