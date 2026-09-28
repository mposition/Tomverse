-- The display contract a message was rendered to, and the reasons a send stops
-- because of it.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 7.6 (C16,
-- C33).
--
-- Nothing here sends anything, and no row is written by this migration.
--
-- ## The pinned hash
--
-- Rendering is fixed at enqueue and authority is decided again at send. C16 is
-- the gap between them: the display obligations can change while a message waits,
-- and the footer it carries may no longer be the footer the law requires. The
-- contract it was rendered to is pinned here, recomputed at send, and a
-- difference is `display_contract_changed` -- skip, and enqueue a replacement
-- under the current contract.
--
-- A hash rather than the contract, because the comparison is equality and the
-- value is long; the verdict snapshot keeps the value.
--
-- Nullable, because every row that exists predates this and because the
-- credential lane has no display obligations to compose. A null at send is not a
-- pass: `releaseNotesSendVerdict()` reads it as a contract that cannot be
-- confirmed, which is the same refusal as one that moved.
--
-- ## The five reasons
--
-- `display_contract_changed` is the one C16 names, and it is the only skip that
-- has a replacement: the message is not refused, it is re-rendered.
--
-- `display_unsatisfiable` is not the same thing and does not get one. Two
-- candidate countries each requiring their own token at the front of the subject
-- cannot both have it, so there is no contract to render and a replacement would
-- be refused in the same way (section 5.3).
--
-- `obligation_undecided` is a statutory duty of some candidate country that this
-- build has not settled (section 7.8). Also not a re-render: the duty has to be
-- settled by somebody first.
--
-- `permission_revoked` and `consent_withdrawn` are section 7.6's own words for a
-- send-time verdict that the enqueue-time one allowed. They are separate from
-- `no_consent` and `consent_lapsed`, which are about a message that never had a
-- basis; these two are about one that had it and lost it, which is the difference
-- an operator asking "what changed" is asking about.

BEGIN;

ALTER TABLE "EmailDelivery"
    ADD COLUMN "displayContractHash" TEXT;

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_displayContractHash_check"
    CHECK ("displayContractHash" IS NULL OR "displayContractHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_skip_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'jurisdiction_profile_missing', 'jurisdiction_footer_incomplete',
        'credential_expired', 'dry_run', 'marketing_halted',
        'marketing_disabled', 'marketing_country_not_allowed',
        -- Kept from 20260915150000: this constraint replaces the list, so a
        -- reason missing here is a reason the table stops accepting.
        'campaign_cancelled',
        'display_contract_changed', 'display_unsatisfiable',
        'obligation_undecided', 'permission_revoked', 'consent_withdrawn'
    ));

-- A replacement exists because its predecessor's contract moved, and the
-- predecessor has to say so.
--
-- Not a CHECK: PostgreSQL does not allow a subquery in one, and the fact is about
-- two rows. A trigger reads the predecessor FOR SHARE, so a concurrent update of
-- its skip reason either is visible here or waits for this insert.
--
-- Any other reason on a superseded row would mean a message was re-enqueued for a
-- reason that does not produce a replacement, and nothing afterwards could tell
-- which of the two facts was wrong.
CREATE FUNCTION "email_delivery_supersedes_reason"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    predecessor RECORD;
BEGIN
    IF NEW."supersedesDeliveryId" IS NULL THEN
        RETURN NEW;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT d."status", d."skipReason" FROM %I."EmailDelivery" d
          WHERE d."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO predecessor USING NEW."supersedesDeliveryId";

    IF predecessor IS NULL THEN
        RAISE EXCEPTION 'EmailDelivery % does not exist, so nothing supersedes it.',
            NEW."supersedesDeliveryId"
            USING ERRCODE = 'check_violation';
    END IF;

    -- One reason a message is still owed but cannot go out as this row: its
    -- display contract moved. A sealed allowed decision is never replaced -- that
    -- attempt may already have reached the provider, and a replacement carries a
    -- new idempotency key (see decideReleaseNotesSend()).
    IF predecessor."status" <> 'skipped'
        OR predecessor."skipReason" IS DISTINCT FROM 'display_contract_changed'
    THEN
        RAISE EXCEPTION
            'EmailDelivery % is %/% and only a delivery skipped as display_contract_changed has a replacement.',
            NEW."supersedesDeliveryId", predecessor."status",
            COALESCE(predecessor."skipReason", 'null')
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_delivery_supersedes_reason"
    BEFORE INSERT OR UPDATE OF "supersedesDeliveryId" ON "EmailDelivery"
    FOR EACH ROW EXECUTE FUNCTION "email_delivery_supersedes_reason"();

COMMIT;
