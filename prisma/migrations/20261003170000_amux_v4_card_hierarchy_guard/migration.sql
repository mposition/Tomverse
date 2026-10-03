-- Keep v4 cards inside the approved non-runnable hierarchy. This is an
-- additive fence: it does not backfill cards, change existing statuses, or
-- open the v4 registration/promotion writers.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION amux_v4_card_hierarchy_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    feature_level text;
    feature_state text;
    story_type text;
    story_source text;
    story_feature text;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD."sourceSystem" = 'admin-idea-v4' THEN
        IF NEW."sourceSystem" IS DISTINCT FROM OLD."sourceSystem" OR
           NEW."cardType" IS DISTINCT FROM OLD."cardType" OR
           NEW."parentFeatureNodeId" IS DISTINCT FROM OLD."parentFeatureNodeId" OR
           NEW."parentStoryCardId" IS DISTINCT FROM OLD."parentStoryCardId" OR
           NEW."v4SourceApprovalId" IS DISTINCT FROM OLD."v4SourceApprovalId" THEN
            RAISE EXCEPTION 'AMUX v4 card hierarchy and source approval are immutable'
                USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' THEN
        RETURN NEW;
    END IF;

    -- SHARE conflicts with a concurrent archive UPDATE, so an insert cannot
    -- race past the parent's active-state check.
    SELECT "level", "state" INTO feature_level, feature_state
      FROM public."AmuxPortfolioNode"
     WHERE "id" = NEW."parentFeatureNodeId" FOR SHARE;
    IF feature_level IS DISTINCT FROM 'feature' OR feature_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'AMUX v4 card requires an active Feature parent'
            USING ERRCODE = 'P0001';
    END IF;

    IF NEW."cardType" = 'story' THEN
        IF NEW."parentStoryCardId" IS NOT NULL THEN
            RAISE EXCEPTION 'AMUX v4 Story cannot have a parent Story'
                USING ERRCODE = 'P0001';
        END IF;
    ELSIF NEW."cardType" = 'task' AND NEW."parentStoryCardId" IS NOT NULL THEN
        SELECT "cardType", "sourceSystem", "parentFeatureNodeId"
          INTO story_type, story_source, story_feature
          FROM public."AmuxWorkItem"
         WHERE "id" = NEW."parentStoryCardId" FOR SHARE;
        IF story_type IS DISTINCT FROM 'story' OR
           story_source IS DISTINCT FROM 'admin-idea-v4' OR
           story_feature IS DISTINCT FROM NEW."parentFeatureNodeId" THEN
            RAISE EXCEPTION 'AMUX v4 Task parent must be a Story in the same Feature'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxWorkItem_v4_hierarchy_guard"
BEFORE INSERT OR UPDATE ON "AmuxWorkItem"
FOR EACH ROW EXECUTE FUNCTION amux_v4_card_hierarchy_guard();

COMMIT;
