-- A retention worker removes the active ciphertext before deleting its
-- external key. Once purged, no ordinary writer may restore that body or
-- move its original deadline forward. These guards are independent of the
-- worker and remain in force after a DB restore.
-- baseline-check: present-if-function "amux_v4_raw_no_resurrection_guard"
BEGIN;

CREATE FUNCTION amux_v4_raw_no_resurrection_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."rawPurgedAt" IS NOT NULL AND (
    NEW."rawPurgedAt" IS DISTINCT FROM OLD."rawPurgedAt" OR
    NEW."rawCiphertext" IS NOT NULL OR NEW."rawKeyId" IS NOT NULL OR
    NEW."rawKeyVersion" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AMUX v4 raw idea cannot be restored after purge'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_raw_no_resurrection_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaSubmission_raw_no_resurrection_guard"
BEFORE UPDATE ON "AmuxIdeaSubmission"
FOR EACH ROW EXECUTE FUNCTION amux_v4_raw_no_resurrection_guard();

CREATE FUNCTION amux_v4_payload_no_resurrection_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."payloadPurgedAt" IS NOT NULL AND (
    NEW."payloadPurgedAt" IS DISTINCT FROM OLD."payloadPurgedAt" OR
    NEW."payloadCiphertext" IS NOT NULL OR NEW."payloadKeyId" IS NOT NULL OR
    NEW."payloadKeyVersion" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AMUX v4 transfer payload cannot be restored after purge'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTransferPreview_payload_no_resurrection_check';
  END IF;
  IF OLD."payloadCiphertext" IS NOT NULL AND OLD."payloadPurgeAfter" IS NOT NULL AND
     (NEW."payloadPurgeAfter" IS NULL OR
      NEW."payloadPurgeAfter" > OLD."payloadPurgeAfter") THEN
    RAISE EXCEPTION 'AMUX v4 transfer payload purge cannot be postponed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTransferPreview_payload_purge_monotonic_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaTransferPreview_payload_no_resurrection_guard"
BEFORE UPDATE ON "AmuxIdeaTransferPreview"
FOR EACH ROW EXECUTE FUNCTION amux_v4_payload_no_resurrection_guard();

CREATE FUNCTION amux_v4_freeform_no_resurrection_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."freeformPurgedAt" IS NOT NULL AND (
    NEW."freeformPurgedAt" IS DISTINCT FROM OLD."freeformPurgedAt" OR
    NEW."freeformCiphertext" IS NOT NULL OR NEW."freeformKeyId" IS NOT NULL OR
    NEW."freeformKeyVersion" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AMUX v4 freeform result cannot be restored after purge'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_freeform_no_resurrection_check';
  END IF;
  IF OLD."freeformCiphertext" IS NOT NULL AND OLD."freeformPurgeAfter" IS NOT NULL AND
     (NEW."freeformPurgeAfter" IS NULL OR
      NEW."freeformPurgeAfter" > OLD."freeformPurgeAfter") THEN
    RAISE EXCEPTION 'AMUX v4 freeform purge cannot be postponed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_freeform_purge_monotonic_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaAnalysisChunk_freeform_no_resurrection_guard"
BEFORE UPDATE ON "AmuxIdeaAnalysisChunk"
FOR EACH ROW EXECUTE FUNCTION amux_v4_freeform_no_resurrection_guard();

COMMIT;
