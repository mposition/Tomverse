-- A read manifest is created with its encrypted body. Only the seven-day
-- retention transition may produce the purged shape and retirement audit.
BEGIN;

CREATE FUNCTION "amux_v19_read_manifest_active_insert_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."ciphertext" IS NULL OR NEW."keyId" IS NULL OR
     NEW."keyVersion" IS NULL OR NEW."bodyPurgedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v19 read manifest insert requires an active body'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_active_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaTrackedCheckoutReadManifest_active_insert_guard"
  BEFORE INSERT ON "AmuxIdeaTrackedCheckoutReadManifest"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_read_manifest_active_insert_guard"();

COMMIT;
