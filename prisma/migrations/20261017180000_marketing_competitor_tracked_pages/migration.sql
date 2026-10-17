-- The pages A3 reads for each approved competitor (S3 plan, S3f; operator
-- decision 2026-10-17: facts come from fixed pages a person approved, and web
-- search is only for finding new competitors).
--
-- A tracked page is an https URL on one of the row's own official hosts, so a
-- fact read from it can only cite a host a person approved. The pages move
-- only into an approval and are compared with the person's audit row like the
-- name and the hosts; the write guard is replaced to say so. Existing rows get
-- no pages: an approval before this change named none.

-- AlterTable
ALTER TABLE "MarketingCompetitor" ADD COLUMN "trackedPages" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- At most ten https URLs of at most 500 characters, each on one of the row's
-- own official hosts: the host part is everything between the scheme and the
-- first '/', '?' or '#', so a port or a user name is not a host and fails.
CREATE FUNCTION "marketing_competitor_pages_valid"("pages" TEXT[], "hosts" TEXT[])
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.cardinality("pages") <= 10
       AND COALESCE(pg_catalog.bool_and(
             "page" IS NOT NULL
             AND pg_catalog.length("page") <= 500
             AND "page" ~ '^https://[^/?#]+([/?#].*)?$'
             AND pg_catalog.substring("page", '^https://([^/?#]+)') = ANY ("hosts")
           ), true)
    FROM pg_catalog.unnest("pages") AS "page"
$$ LANGUAGE sql;

ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_trackedPages_check"
    CHECK ("trackedPages" IS NOT NULL AND "marketing_competitor_pages_valid"("trackedPages", "officialHosts"));

-- A proposal tracks nothing yet: A3 suggests a competitor, a person decides
-- which of its pages are worth reading.
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_proposal_tracks_nothing_check"
    CHECK ("status" <> 'proposed' OR pg_catalog.cardinality("trackedPages") = 0);

CREATE OR REPLACE FUNCTION "marketing_competitor_write_guard"() RETURNS trigger AS $$
DECLARE
    previous_decision TEXT;
    decision_action TEXT;
    decision_target_type TEXT;
    decision_target TEXT;
    decision_actor TEXT;
    decision_metadata JSONB;
BEGIN
    NEW."decidedAt" := NULL;
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" = 'proposed' THEN
            IF NEW."decisionAuditLogId" IS NOT NULL THEN
                RAISE EXCEPTION 'marketing_competitor_proposal_has_no_decision';
            END IF;
            RETURN NEW;
        END IF;
        -- A person may add a competitor already approved; nothing else starts decided.
        IF NEW."status" <> 'approved' OR NEW."proposedBy" <> 'operator' THEN
            RAISE EXCEPTION 'marketing_competitor_insert_not_proposed';
        END IF;
        previous_decision := NULL;
    ELSE
        -- What a proposal said and when it was made never change.
        IF pg_catalog.jsonb_build_array(OLD."id", OLD."proposedBy", OLD."proposedRunId",
                                        OLD."evidenceUrls", OLD."rationale", OLD."createdAt")
           IS DISTINCT FROM
           pg_catalog.jsonb_build_array(NEW."id", NEW."proposedBy", NEW."proposedRunId",
                                        NEW."evidenceUrls", NEW."rationale", NEW."createdAt") THEN
            RAISE EXCEPTION 'marketing_competitor_proposal_is_immutable';
        END IF;
        -- A person may change their mind: a rejected or retired competitor can be
        -- approved again. Only a proposal can be rejected; only an approval retired.
        IF NOT (
            (OLD."status" = 'proposed' AND NEW."status" IN ('approved', 'rejected'))
            OR (OLD."status" = 'approved' AND NEW."status" = 'retired')
            OR (OLD."status" IN ('rejected', 'retired') AND NEW."status" = 'approved')
        ) THEN
            RAISE EXCEPTION 'marketing_competitor_transition_invalid';
        END IF;
        -- The name, hosts and tracked pages are what a person approves, so they
        -- move only into an approval -- never on a rejection or a retirement.
        IF NEW."status" <> 'approved'
           AND (NEW."displayName" IS DISTINCT FROM OLD."displayName"
                OR NEW."officialHosts" IS DISTINCT FROM OLD."officialHosts"
                OR NEW."trackedPages" IS DISTINCT FROM OLD."trackedPages") THEN
            RAISE EXCEPTION 'marketing_competitor_hosts_change_only_on_approval';
        END IF;
        IF NEW."decisionAuditLogId" IS NOT DISTINCT FROM OLD."decisionAuditLogId" THEN
            RAISE EXCEPTION 'marketing_competitor_decision_not_a_person';
        END IF;
        previous_decision := OLD."decisionAuditLogId";
    END IF;

    IF NEW."decisionAuditLogId" IS NULL THEN
        RAISE EXCEPTION 'marketing_competitor_decision_not_a_person';
    END IF;
    EXECUTE format(
        'SELECT "action", "targetType", "targetId", "actorUserId", "metadata"::jsonb FROM %I."AdminAuditLog" WHERE "id" = $1',
        TG_TABLE_SCHEMA)
        INTO decision_action, decision_target_type, decision_target, decision_actor, decision_metadata
        USING NEW."decisionAuditLogId";
    IF decision_action IS DISTINCT FROM ('marketing_competitor.' || NEW."status")
       OR decision_target_type IS DISTINCT FROM 'MarketingCompetitor'
       OR decision_target IS DISTINCT FROM NEW."id"
       OR decision_actor IS NULL
       OR decision_metadata IS NULL
       OR pg_catalog.jsonb_typeof(decision_metadata) IS DISTINCT FROM 'object'
       OR (decision_metadata ->> 'systemActor') IS NOT NULL
       OR (decision_metadata ->> 'previousDecisionAuditLogId') IS DISTINCT FROM COALESCE(previous_decision, ':none')
       OR (NEW."status" = 'approved'
           AND ((decision_metadata ->> 'displayName') IS DISTINCT FROM NEW."displayName"
                OR (decision_metadata -> 'officialHosts') IS DISTINCT FROM pg_catalog.to_jsonb(NEW."officialHosts")
                OR (decision_metadata -> 'trackedPages') IS DISTINCT FROM pg_catalog.to_jsonb(NEW."trackedPages"))) THEN
        RAISE EXCEPTION 'marketing_competitor_decision_not_a_person';
    END IF;

    NEW."decidedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
