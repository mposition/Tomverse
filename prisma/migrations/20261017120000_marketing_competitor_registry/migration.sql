-- The competitors the market-intelligence agent (A3) tracks, and the official
-- hosts a fact about each may come from (S3 plan, S3f; operator decision
-- 2026-10-17). A3 proposes a competitor it finds; a person approves, rejects
-- or retires it. Only an approved row's hosts make a market fact storable, so
-- which sources are trusted stays a person's decision (agent foundation
-- principle 6) while the list itself can grow every run.
--
-- The decision is a person's audit row. It is checked here rather than by a
-- foreign key because a relation would add a back relation to AdminAuditLog,
-- which is in the marketing webhook schema slice; the audit chain is
-- append-only, so a row checked once cannot later disappear.

-- CreateTable
CREATE TABLE "MarketingCompetitor" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "officialHosts" TEXT[],
    "status" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "proposedRunId" TEXT,
    "evidenceUrls" TEXT[],
    "rationale" TEXT,
    "decisionAuditLogId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCompetitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCompetitor_decisionAuditLogId_key" ON "MarketingCompetitor"("decisionAuditLogId");

-- CreateIndex
CREATE INDEX "MarketingCompetitor_status_idx" ON "MarketingCompetitor"("status");

-- ---------------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------------

-- A host is matched exactly by the app (lib/marketingIntelReportCore.ts), so it
-- is stored the way it is compared: lower case, no scheme, port, path or
-- trailing dot, at least one dot.
CREATE FUNCTION "marketing_competitor_hosts_valid"("hosts" TEXT[])
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.cardinality("hosts") BETWEEN 1 AND 10
       AND pg_catalog.bool_and(
             "host" IS NOT NULL
             AND pg_catalog.length("host") <= 253
             AND "host" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           )
    FROM pg_catalog.unnest("hosts") AS "host"
$$ LANGUAGE sql;

CREATE FUNCTION "marketing_competitor_evidence_valid"("urls" TEXT[])
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.cardinality("urls") <= 5
       AND COALESCE(pg_catalog.bool_and(
             "url" IS NOT NULL AND "url" LIKE 'https://%' AND pg_catalog.length("url") <= 500
           ), true)
    FROM pg_catalog.unnest("urls") AS "url"
$$ LANGUAGE sql;

ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_id_check"
    CHECK ("id" ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_displayName_check"
    CHECK (pg_catalog.length("displayName") BETWEEN 1 AND 80);
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_officialHosts_check"
    CHECK ("officialHosts" IS NOT NULL AND "marketing_competitor_hosts_valid"("officialHosts"));
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_evidenceUrls_check"
    CHECK ("evidenceUrls" IS NOT NULL AND "marketing_competitor_evidence_valid"("evidenceUrls"));
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_rationale_check"
    CHECK ("rationale" IS NULL OR pg_catalog.length("rationale") <= 400);
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_status_check"
    CHECK ("status" IN ('proposed', 'approved', 'rejected', 'retired'));
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_proposedBy_check"
    CHECK ("proposedBy" IN ('generator', 'operator', 'seed'));
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_proposedRunId_check"
    CHECK (("proposedBy" = 'generator') = ("proposedRunId" IS NOT NULL)
           AND ("proposedRunId" IS NULL OR "proposedRunId" ~ '^[A-Za-z0-9_-]{1,64}$'));
-- A decided row names its decision; a proposal has none.
ALTER TABLE "MarketingCompetitor" ADD CONSTRAINT "MarketingCompetitor_decision_check"
    CHECK ((("status" = 'proposed') = ("decisionAuditLogId" IS NULL))
           AND (("decisionAuditLogId" IS NULL) = ("decidedAt" IS NULL)));

-- ---------------------------------------------------------------------------
-- Decisions
-- ---------------------------------------------------------------------------

-- One guard for both writes, because the decision check reads the audit table
-- by a name built from TG_TABLE_SCHEMA: search_path is pinned to pg_catalog,
-- pg_temp, so neither the table nor a helper function would resolve by name.
--
-- A decision is a person's audit row (an actor, no system actor) for this
-- competitor and this status, made with this row's previous decision in view
-- (':none' for none), and -- for an approval -- about exactly this name and
-- these hosts.
CREATE FUNCTION "marketing_competitor_write_guard"() RETURNS trigger AS $$
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
        -- The name and hosts are what a person approves, so they move only into an
        -- approval -- never on a rejection or a retirement.
        IF NEW."status" <> 'approved'
           AND (NEW."displayName" IS DISTINCT FROM OLD."displayName"
                OR NEW."officialHosts" IS DISTINCT FROM OLD."officialHosts") THEN
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
                OR (decision_metadata -> 'officialHosts') IS DISTINCT FROM pg_catalog.to_jsonb(NEW."officialHosts"))) THEN
        RAISE EXCEPTION 'marketing_competitor_decision_not_a_person';
    END IF;

    NEW."decidedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingCompetitor_write_guard"
    BEFORE INSERT OR UPDATE ON "MarketingCompetitor"
    FOR EACH ROW EXECUTE FUNCTION "marketing_competitor_write_guard"();

-- A competitor is retired, never deleted: the facts stored under its id keep
-- pointing at the row that said its hosts were official.
CREATE FUNCTION "marketing_competitor_is_never_deleted"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'marketing_competitor_is_never_deleted';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingCompetitor_is_never_deleted"
    BEFORE DELETE ON "MarketingCompetitor"
    FOR EACH ROW EXECUTE FUNCTION "marketing_competitor_is_never_deleted"();

-- ---------------------------------------------------------------------------
-- The first proposals: A3's market analysis of 2026-10-17, for a person to
-- approve, edit or reject in Admin. Nothing here is trusted until then.
-- ---------------------------------------------------------------------------

INSERT INTO "MarketingCompetitor" ("id", "displayName", "officialHosts", "status", "proposedBy", "evidenceUrls", "rationale", "updatedAt")
VALUES
    ('perplexity', 'Perplexity', ARRAY['perplexity.ai', 'www.perplexity.ai'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'Model Council runs several models in parallel and merges them: the same proposition, reported on Pro as well as Max.', CURRENT_TIMESTAMP),
    ('suprmind', 'Suprmind', ARRAY['suprmind.ai'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'Cross-checks five frontier models in one thread; a specialist in what AI Review does.', CURRENT_TIMESTAMP),
    ('chatplayground', 'ChatPlayground AI', ARRAY['chatplayground.ai', 'www.chatplayground.ai'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'One prompt to 20+ models side by side, sold heavily as a lifetime deal.', CURRENT_TIMESTAMP),
    ('genspark', 'Genspark', ARRAY['genspark.ai', 'www.genspark.ai'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'Mixture-of-Agents over many models with shared credits; unlimited chat promotion to the end of 2026.', CURRENT_TIMESTAMP),
    ('chathub', 'ChatHub', ARRAY['chathub.gg'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'Long-standing side-by-side comparison brand, up to six models at once.', CURRENT_TIMESTAMP),
    ('poe', 'Poe', ARRAY['poe.com'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'The reference for model breadth and price ladder; cut Premium points on 2026-07-28.', CURRENT_TIMESTAMP),
    ('adot', 'SKT A. (adot)', ARRAY['adot.ai', 'news.sktelecom.com'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'Free multi-LLM comparison in Korea (eight models in a PC browser): the Korean free baseline.', CURRENT_TIMESTAMP),
    ('wrtn', 'Wrtn', ARRAY['wrtn.ai'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'Korean multi-model chat; reported to have moved from free to paid in 2026.', CURRENT_TIMESTAMP),
    ('chatgpt', 'ChatGPT (OpenAI)', ARRAY['openai.com', 'chatgpt.com', 'help.openai.com'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'First-party price and feature baseline, checked monthly.', CURRENT_TIMESTAMP),
    ('claude', 'Claude (Anthropic)', ARRAY['www.anthropic.com', 'claude.com', 'support.claude.com'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'First-party price and feature baseline, checked monthly.', CURRENT_TIMESTAMP),
    ('gemini', 'Gemini (Google)', ARRAY['gemini.google', 'blog.google', 'support.google.com'], 'proposed', 'seed', ARRAY[]::TEXT[],
     'First-party baseline, including answer double-check; checked monthly.', CURRENT_TIMESTAMP);
