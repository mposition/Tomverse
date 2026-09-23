-- One named exception to "a marketing post starts as a draft", for the
-- autonomous scheduled insert.
--
-- Authority: S1 implementation plan r7 amendment 2, approved by @mposition on
-- 2026-09-23, and the S2 plan's "Autonomous insert: complete shape".
--
-- What this is not. It does not lift the refusal for `createMarketingPost`,
-- and it adds no `drafted -> scheduled` edge to the update whitelist. A post
-- that starts as a draft still cannot walk to `scheduled`; the only way to a
-- scheduled autonomous row is to be inserted as one, in a single transaction,
-- by the one store function that can satisfy every clause below.
--
-- What the trigger can and cannot decide. Everything here is a property of the
-- row in front of it. The clauses that need another row -- that the template
-- still matches at the database clock, that the facts digest binds the facts
-- re-resolved in this transaction, that the sealed decision is the one that
-- produced these rule ids -- cannot be checked from a `BEFORE INSERT` without
-- reading tables it must not read, so they belong to the store function and
-- are checked there inside the same transaction. This trigger is the half that
-- cannot be forgotten: a row of the wrong shape is refused by the database
-- whatever the caller believed.

CREATE OR REPLACE FUNCTION "marketing_post_starts_as_one_draft"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    autonomous_scheduled boolean;
BEGIN
    NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';

    -- The shape the exception is defined as. Recognising it is not accepting
    -- it: every clause below still has to hold, and the ones this shape does
    -- not satisfy are the ones that refuse it.
    autonomous_scheduled := NEW."status" = 'scheduled' AND NEW."mode" = 'autonomous';

    IF NEW."historyVersion" <> 0 THEN
        RAISE EXCEPTION 'MarketingPost % must start at history version zero', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- One draft entry, and it says which envelope was drafted. The digest
    -- was checked by the store and not by this trigger, so a row inserted any
    -- other way could carry a first entry that named nothing -- and the first
    -- entry is what every later append is compared against.
    IF pg_catalog.jsonb_array_length(NEW."history") <> 1
        OR NEW."history" -> 0 ->> 'type' IS DISTINCT FROM 'draft'
        OR NEW."history" -> 0 ->> 'envelopeDigest' IS DISTINCT FROM NEW."envelopeDigest" THEN
        RAISE EXCEPTION 'MarketingPost % must start with one draft history entry naming its envelope', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT autonomous_scheduled AND NEW."status" NOT IN ('drafted', 'guard_rejected') THEN
        RAISE EXCEPTION 'MarketingPost % must be created as a draft, not as %', NEW."id", NEW."status"
            USING ERRCODE = 'check_violation';
    END IF;

    IF autonomous_scheduled THEN
        -- A scheduled row has a slot, and it is the one the envelope names.
        -- Reading it from the envelope rather than trusting the column is the
        -- point: the column is what the publisher acts on and the envelope is
        -- what the Guard judged, and a row where they disagree is a row that
        -- goes out at a time nobody decided.
        IF NEW."scheduledAt" IS NULL
            OR NEW."envelope" IS NULL
            OR NEW."envelope" ->> 'scheduledAt' IS NULL
            OR (NEW."envelope" ->> 'scheduledAt')::timestamptz
                IS DISTINCT FROM NEW."scheduledAt" AT TIME ZONE 'UTC' THEN
            RAISE EXCEPTION 'MarketingPost % must be scheduled for the instant its envelope names', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- The decision this row carries. `autonomous_eligible` is the only
        -- verdict that reaches here without a person, so it is the only one
        -- that may arrive already scheduled, and it carries no codes: codes
        -- belong to the two verdicts that have something to say.
        --
        -- `guardRuleIds` is deliberately not required to be non-empty. An
        -- empty list is what `guardDraft()` actually returns for an
        -- autonomous decision -- the rule ids it collects are the ones that
        -- had something to say, and a decision that reaches autonomy has none.
        -- Requiring one refused every legitimate row this exception exists
        -- for, and the integration fixture that wrote a rule id hid it.
        IF NEW."guardDecision" <> 'autonomous_eligible'
            OR pg_catalog.array_length(NEW."guardCodes", 1) IS NOT NULL
            OR NEW."factsDigest" IS NULL THEN
            RAISE EXCEPTION 'MarketingPost % must carry a sealed autonomous decision', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- Autonomy is only ever inside an approved template
        -- (docs/policy/marketing-automation.md §6). A scheduled autonomous row
        -- with no template is a post nobody approved the words of.
        IF NEW."templateId" IS NULL OR NEW."templateDigest" IS NULL THEN
            RAISE EXCEPTION 'MarketingPost % must name the template it reuses', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- It is not approved, and it is not a template. Writing either here
        -- would let the autonomous path mint its own approval, or make its
        -- output the source another autonomous post inherits.
        IF NEW."approvalAuditLogId" IS NOT NULL
            OR NEW."approvedAt" IS NOT NULL
            OR NEW."approvedDigest" IS NOT NULL
            OR NEW."approvalExpiresAt" IS NOT NULL
            OR NEW."reusableAsTemplate" THEN
            RAISE EXCEPTION 'MarketingPost % cannot be created as though a person had approved it', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- The publisher claims its own work. A row that arrives holding a slot
        -- or a lease has been handed one by its writer.
        IF NEW."slotDate" IS NOT NULL
            OR NEW."claimToken" IS NOT NULL
            OR NEW."leaseUntil" IS NOT NULL THEN
            RAISE EXCEPTION 'MarketingPost % cannot be created already claimed', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- Nothing has happened to it yet.
        IF NEW."externalUrl" IS NOT NULL
            OR NEW."verifiedPublicAt" IS NOT NULL
            OR NEW."verificationMethod" IS NOT NULL
            OR NEW."errorCode" IS NOT NULL
            OR NEW."outcomeUnknownAt" IS NOT NULL
            OR NEW."deletedAt" IS NOT NULL
            OR NEW."deletionMethod" IS NOT NULL
            OR NEW."legalHold" THEN
            RAISE EXCEPTION 'MarketingPost % cannot be created with an outcome', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW."publishedAt" IS NOT NULL
        OR NEW."publishAttempt" <> 0
        OR NEW."providerRequestKey" IS NOT NULL
        OR NEW."externalPostId" IS NOT NULL
        OR NEW."contentPurgedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'MarketingPost % cannot be created as though it had been published', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
