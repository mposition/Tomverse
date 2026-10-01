-- AMUX v4 stable draft references, additive and dark. Existing draft rows may
-- retain NULL and are deliberately not backfilled; every new row must carry a
-- canonical, idea-scoped reference. Its ordinal is not unitIndex.
-- No registration writer, card state transition, or live analysis is enabled.

BEGIN;

ALTER TABLE "AmuxIdeaDraftUnit"
    ADD COLUMN "localRef" TEXT;

ALTER TABLE "AmuxIdeaDraftUnit"
    ADD CONSTRAINT "AmuxIdeaDraftUnit_local_ref_shape_check" CHECK (
        "localRef" IS NULL OR (
            length("localRef") <= 128 AND
            "localRef" ~ '^c(0|[1-9][0-9]*):(node|card|evidence)-(0|[1-9][0-9]{0,3})$' AND
            split_part("localRef", ':', 1) = 'c' || "chunkIndex"::text AND
            split_part(split_part("localRef", ':', 2), '-', 1) = "unitKind"
        )
    );

CREATE UNIQUE INDEX "AmuxIdeaDraftUnit_ideaId_localRef_key"
    ON "AmuxIdeaDraftUnit"("ideaId", "localRef");

CREATE FUNCTION amux_v4_draft_local_ref_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW."localRef" IS NULL THEN
        RAISE EXCEPTION 'new draft unit requires a local reference'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_local_ref_required_check';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."localRef" IS DISTINCT FROM OLD."localRef" THEN
        RAISE EXCEPTION 'draft unit local reference is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_local_ref_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaDraftUnit_local_ref_guard"
BEFORE INSERT OR UPDATE ON "AmuxIdeaDraftUnit"
FOR EACH ROW EXECUTE FUNCTION amux_v4_draft_local_ref_guard();

COMMIT;
