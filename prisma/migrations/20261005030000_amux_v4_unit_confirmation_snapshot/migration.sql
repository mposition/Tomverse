-- A09 stores only the bounded, non-body confirmation metadata needed to
-- re-evaluate a prepared owner decision. The existing unit/source digests
-- remain authoritative; this column must never contain proposal text.
ALTER TABLE "AmuxIdeaUnitDecision"
  ADD COLUMN "confirmationSnapshot" JSONB;

ALTER TABLE "AmuxIdeaUnitDecision"
  ADD CONSTRAINT "AmuxIdeaUnitDecision_confirmation_snapshot_size_check"
  CHECK ("confirmationSnapshot" IS NULL OR
    (jsonb_typeof("confirmationSnapshot") = 'object' AND
     octet_length("confirmationSnapshot"::text) <= 32768)) NOT VALID;

CREATE FUNCTION amux_v4_unit_snapshot_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     NEW."confirmationSnapshot" IS DISTINCT FROM OLD."confirmationSnapshot" THEN
    RAISE EXCEPTION 'prepared confirmation snapshot is immutable'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaUnitDecision_confirmation_snapshot_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amux_v4_unit_snapshot_immutable_guard_trigger
BEFORE UPDATE ON "AmuxIdeaUnitDecision"
FOR EACH ROW EXECUTE FUNCTION amux_v4_unit_snapshot_immutable_guard();

-- Story and Task problem, scope and completion criteria are independently
-- purgeable encrypted content, never the legacy plaintext description.
ALTER TABLE "AmuxWorkItem"
  ADD COLUMN "v4BodyCiphertext" BYTEA,
  ADD COLUMN "v4BodyKeyId" TEXT,
  ADD COLUMN "v4BodyKeyVersion" INTEGER,
  ADD COLUMN "v4BodyDigest" TEXT,
  ADD COLUMN "v4BodyDigestKeyId" TEXT,
  ADD COLUMN "v4BodyPurgedAt" TIMESTAMP(3);

ALTER TABLE "AmuxWorkItem"
  ADD CONSTRAINT "AmuxWorkItem_v4_body_envelope_check" CHECK (
    CASE WHEN "sourceSystem" IS NOT DISTINCT FROM 'admin-idea-v4' THEN
      COALESCE(("v4BodyDigest" ~ '^[a-f0-9]{64}$' AND
        length("v4BodyDigestKeyId") > 0 AND
        (("v4BodyPurgedAt" IS NULL AND "v4BodyCiphertext" IS NOT NULL AND
          length("v4BodyKeyId") > 0 AND "v4BodyKeyVersion" > 0) OR
         ("v4BodyPurgedAt" IS NOT NULL AND "v4BodyCiphertext" IS NULL AND
          "v4BodyKeyId" IS NULL AND "v4BodyKeyVersion" IS NULL AND
          "status" IN ('done', 'cancelled') AND "v4TerminalAt" IS NOT NULL))), false)
    ELSE
      "v4BodyCiphertext" IS NULL AND "v4BodyKeyId" IS NULL AND
      "v4BodyKeyVersion" IS NULL AND "v4BodyDigest" IS NULL AND
      "v4BodyDigestKeyId" IS NULL AND "v4BodyPurgedAt" IS NULL
    END
  ) NOT VALID;
