-- Every existing account gets the preference rows it should always have had.
--
-- docs/policy/email-notifications.md §17.1.
--
-- `ensureDefaultPreferences()` runs on a settings read, so these rows exist
-- only for accounts that have opened the preference centre. That was survivable
-- while nothing consulted them and stopped being survivable the moment the send
-- path started reading an absent row as "no consent recorded": an account with
-- no rows would have had every consent-based purpose refused, including for
-- people who would have said yes.
--
-- The values are §17.1's, unchanged:
--   security, billing, service_status  ON   (contract performance; the first
--                                            two cannot be switched off at all)
--   product_updates, newsletter,
--   promotions                         OFF  (nobody has agreed to anything)
--
-- **No ConsentRecord rows.** Writing `granted` for a default would put a false
-- statement in the one table whose entire purpose is to be true about consent,
-- and CASL and the Australian Spam Act both put the burden of proving consent
-- on the sender. §17.1 is explicit about this and it is the part worth getting
-- right: an empty consent history is the honest answer for people who have
-- never been asked.
--
-- Ids are derived rather than random so the insert is idempotent and a re-run
-- changes nothing, following the derived-id backfill in
-- 20260804010000_image_multimodel_groups.
--
-- `grantedAt` is set only where the default is on, matching what
-- ensureDefaultPreferences writes; it records when this state began, which for
-- a default is when the row was made.

INSERT INTO "EmailPreference"
    ("id", "userId", "purpose", "enabled", "source", "grantedAt", "createdAt", "updatedAt")
SELECT
    'emailpref_v1_' || u."id" || ':' || p."purpose",
    u."id",
    p."purpose",
    p."enabled",
    'system_default',
    CASE WHEN p."enabled" THEN NOW() ELSE NULL END,
    NOW(),
    NOW()
FROM "User" u
CROSS JOIN (
    VALUES
        ('security', true),
        ('billing', true),
        ('service_status', true),
        ('product_updates', false),
        ('newsletter', false),
        ('promotions', false)
) AS p("purpose", "enabled")
ON CONFLICT ("userId", "purpose") DO NOTHING;
