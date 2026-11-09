-- baseline-check: replace-function-if-body-sha256 "marketing_channel_caps_are_lower_only" "283280895f4d73428881b53f441095ea2e132e4011c6b98ed01b342b94bbad46" "756070e1f64f5c3f0653eb93806998df3bf0e837bfb5a5069edae631c101d372"
-- Owner decision 2026-11-08: no policy cap on how many posts an account
-- publishes a day or a week (docs/policy/marketing-automation.md §7.6). Every
-- post is still approved by a person before it goes (§7.4), and each
-- platform's own limits still apply.
--
-- The trigger repeated the policy table and refused an operator override
-- above it. With no policy cap there is nothing to be above: an override is
-- now the account's only cap, any non-negative integer (the existing CHECK),
-- and NULL is no cap. What stays is the RedNote rule: it has no API posting
-- route, so a cap there would throttle nothing and is still refused outright.
-- An unknown channel is still refused by name rather than by `case_not_found`.
--
-- The function and trigger keep their names, so the baseline guard can pin
-- the body this replaces; "lower only" is historical. The trigger itself is
-- unchanged. No row is written, and no existing row can fail the new body: it
-- allows everything the old one did.

CREATE OR REPLACE FUNCTION "marketing_channel_caps_are_lower_only"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    -- MARKETING_API_POSTING_CHANNELS in lib/marketingAutomationSchema.ts.
    -- tests/marketingAutomationSchema.test.mjs compares the two lists.
    CASE NEW."channel"
        WHEN 'linkedin', 'x', 'facebook', 'instagram', 'threads', 'youtube', 'tiktok' THEN
            RETURN NEW;
        WHEN 'rednote' THEN
            IF NEW."dailyCapOverride" IS NOT NULL OR NEW."weeklyCapOverride" IS NOT NULL THEN
                RAISE EXCEPTION 'MarketingChannel % is a manual channel and has no posting cap to override', NEW."accountSlug"
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        ELSE
            RAISE EXCEPTION 'MarketingChannel % has no posting cap for channel %', NEW."accountSlug", NEW."channel"
                USING ERRCODE = 'check_violation';
    END CASE;
END;
$$ LANGUAGE plpgsql;
