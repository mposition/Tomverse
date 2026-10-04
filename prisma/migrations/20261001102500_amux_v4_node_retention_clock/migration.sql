-- AMUX v4 node retention clock, additive and dark. This records the first
-- archive time under the database clock; it does NOT enable content deletion.
-- The existing content-key CHECK and parent guard still reject ciphertext
-- changes. Purge, legal-hold fencing and backup proof require a later gate.

BEGIN;

ALTER TABLE "AmuxPortfolioNode"
    ADD COLUMN "archivedAt" TIMESTAMP(3),
    ADD COLUMN "contentPurgeAfter" TIMESTAMP(3);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM "AmuxPortfolioNode" WHERE "state" = 'archived') THEN
        RAISE EXCEPTION 'existing archived nodes require separate clock reconciliation';
    END IF;
END $$;

ALTER TABLE "AmuxPortfolioNode"
    ADD CONSTRAINT "AmuxPortfolioNode_retention_clock_check" CHECK (
        ("state" = 'active' AND "archivedAt" IS NULL AND "contentPurgeAfter" IS NULL) OR
        ("state" = 'archived' AND "archivedAt" IS NOT NULL AND
         "contentPurgeAfter" = "archivedAt" + INTERVAL '90 days')
    );

CREATE INDEX "AmuxPortfolioNode_contentPurgeAfter_idx"
    ON "AmuxPortfolioNode"("contentPurgeAfter");

CREATE FUNCTION amux_v4_node_retention_clock_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'active' OR NEW."archivedAt" IS NOT NULL OR
           NEW."contentPurgeAfter" IS NOT NULL THEN
            RAISE EXCEPTION 'new portfolio node must start active without a retention clock'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioNode_retention_insert_check';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."state" = 'active' AND NEW."state" = 'archived' THEN
        IF NEW."archivedAt" IS NOT NULL OR NEW."contentPurgeAfter" IS NOT NULL THEN
            RAISE EXCEPTION 'archive clock is set only by the database'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioNode_retention_clock_immutable_check';
        END IF;
        NEW."archivedAt" := db_now;
        NEW."contentPurgeAfter" := db_now + INTERVAL '90 days';
    ELSIF NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" OR
          NEW."contentPurgeAfter" IS DISTINCT FROM OLD."contentPurgeAfter" THEN
        RAISE EXCEPTION 'portfolio retention clock is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioNode_retention_clock_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxPortfolioNode_retention_clock_guard"
BEFORE INSERT OR UPDATE ON "AmuxPortfolioNode"
FOR EACH ROW EXECUTE FUNCTION amux_v4_node_retention_clock_guard();

COMMIT;
