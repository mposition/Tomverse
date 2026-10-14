-- Readable AMUX card numbers (docs/policy/amux-card-display-key.md, approved
-- by mposition 2026-10-14), stage S2: the schema and its guards. Additive
-- only: two nullable columns with their unique indexes and CHECKs, one new
-- table, three functions and four triggers. Nothing here writes a row, and no
-- existing column, constraint or trigger changes.
--
-- What the database enforces (the same rules as lib/amux/cardDisplayKeyCore.ts,
-- compared by tests/amuxCardDisplayKeyCore.test.mjs):
--
-- * AmuxWorkItem."displayKey" is NULL or `AMUX-<PREFIX>-<NNN>`: a prefix of 2
--   to 16 characters from A-Z and 0-9, then a number from 1 to nine digits,
--   zero padded to three. It is unique, and once non-NULL it can be neither
--   changed nor cleared (policy §3).
-- * AmuxPortfolioNode."displayPrefix" is NULL, or set on a Feature node only,
--   well formed, not one of the reserved path prefixes of policy §4, unique,
--   and once non-NULL never changed or cleared (policy §2-6, §2-8).
-- * AmuxCardDisplayKeyCounter holds the last number of each prefix. A row is
--   inserted at 1, an update may only add one, and rows are never deleted or
--   truncated, so a number is never handed out twice (policy §3). The single
--   writer is lib/amux/cardDisplayKeyAllocator.ts, inside the caller's
--   transaction; a rollback takes the increment with it.
--
-- `prisma db push` creates the columns, indexes and table and none of the
-- CHECKs, functions or triggers; the guards are tested on the migration
-- history (tests/integration/amux-card-display-key.db.test.ts).
--
-- Rollback: drop the triggers, the functions, the table, then the two
-- columns. Until S3 no writer assigns a number, so nothing reads them.

BEGIN;

ALTER TABLE "AmuxWorkItem" ADD COLUMN "displayKey" TEXT;
ALTER TABLE "AmuxWorkItem" ADD CONSTRAINT "AmuxWorkItem_displayKey_format_check"
  CHECK ("displayKey" IS NULL OR "displayKey" ~ '^AMUX-[A-Z0-9]{2,16}-(00[1-9]|0[1-9][0-9]|[1-9][0-9]{2,8})$');
CREATE UNIQUE INDEX "AmuxWorkItem_displayKey_key" ON "AmuxWorkItem"("displayKey");

ALTER TABLE "AmuxPortfolioNode" ADD COLUMN "displayPrefix" TEXT;
ALTER TABLE "AmuxPortfolioNode" ADD CONSTRAINT "AmuxPortfolioNode_displayPrefix_check"
  CHECK (
    "displayPrefix" IS NULL OR (
      "level" = 'feature'
      AND "displayPrefix" ~ '^[A-Z0-9]{2,16}$'
      AND "displayPrefix" <> ALL (ARRAY['WORKBOARD', 'INTAKE', 'LOCAL', 'ENG', 'IDEA', 'SYNC', 'LEGACY']::TEXT[])
    )
  );
CREATE UNIQUE INDEX "AmuxPortfolioNode_displayPrefix_key" ON "AmuxPortfolioNode"("displayPrefix");

CREATE TABLE "AmuxCardDisplayKeyCounter" (
    "prefix" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "AmuxCardDisplayKeyCounter_pkey" PRIMARY KEY ("prefix"),
    CONSTRAINT "AmuxCardDisplayKeyCounter_prefix_check" CHECK ("prefix" ~ '^[A-Z0-9]{2,16}$'),
    CONSTRAINT "AmuxCardDisplayKeyCounter_lastNumber_check" CHECK ("lastNumber" BETWEEN 1 AND 999999999)
);

CREATE FUNCTION amux_card_display_key_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'AMUX card display key is immutable once set'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxWorkItem_displayKey_immutable_check';
END;
$$;

CREATE TRIGGER "AmuxWorkItem_display_key_immutable"
BEFORE UPDATE ON "AmuxWorkItem"
FOR EACH ROW
WHEN (OLD."displayKey" IS NOT NULL AND NEW."displayKey" IS DISTINCT FROM OLD."displayKey")
EXECUTE FUNCTION amux_card_display_key_immutable();

CREATE FUNCTION amux_feature_display_prefix_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'AMUX Feature display prefix is immutable once set'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxPortfolioNode_displayPrefix_immutable_check';
END;
$$;

CREATE TRIGGER "AmuxPortfolioNode_display_prefix_immutable"
BEFORE UPDATE ON "AmuxPortfolioNode"
FOR EACH ROW
WHEN (OLD."displayPrefix" IS NOT NULL AND NEW."displayPrefix" IS DISTINCT FROM OLD."displayPrefix")
EXECUTE FUNCTION amux_feature_display_prefix_immutable();

CREATE FUNCTION amux_card_display_counter_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."lastNumber" IS DISTINCT FROM 1 THEN
            RAISE EXCEPTION 'AMUX card display counter starts at 1'
              USING ERRCODE = '23514', CONSTRAINT = 'AmuxCardDisplayKeyCounter_sequence_check';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW."prefix" IS DISTINCT FROM OLD."prefix" OR
           NEW."lastNumber" IS DISTINCT FROM OLD."lastNumber" + 1 THEN
            RAISE EXCEPTION 'AMUX card display counter only advances by one'
              USING ERRCODE = '23514', CONSTRAINT = 'AmuxCardDisplayKeyCounter_sequence_check';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AMUX card display counters are never removed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxCardDisplayKeyCounter_sequence_check';
END;
$$;

CREATE TRIGGER "AmuxCardDisplayKeyCounter_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AmuxCardDisplayKeyCounter"
FOR EACH ROW EXECUTE FUNCTION amux_card_display_counter_guard();

CREATE TRIGGER "AmuxCardDisplayKeyCounter_reject_truncate"
BEFORE TRUNCATE ON "AmuxCardDisplayKeyCounter"
FOR EACH STATEMENT EXECUTE FUNCTION amux_card_display_counter_guard();

COMMIT;
