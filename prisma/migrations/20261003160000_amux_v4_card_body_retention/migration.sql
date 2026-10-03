-- Add a separately encrypted, purgeable v4 card body. Existing cards are
-- untouched; the v4 registration code latch remains closed.
ALTER TABLE "AmuxWorkItem"
    ADD COLUMN "v4BodyCiphertext" BYTEA,
    ADD COLUMN "v4BodyKeyId" TEXT,
    ADD COLUMN "v4BodyKeyVersion" INTEGER,
    ADD COLUMN "v4BodyDigest" TEXT,
    ADD COLUMN "v4BodyDigestKeyId" TEXT,
    ADD COLUMN "v4DisplayPurgedAt" TIMESTAMP(3);

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_v4_body_columns_exclusive_check"
    CHECK (
        "sourceSystem" IS NOT DISTINCT FROM 'admin-idea-v4' OR
        ("v4BodyCiphertext" IS NULL AND "v4BodyKeyId" IS NULL AND
         "v4BodyKeyVersion" IS NULL AND "v4BodyDigest" IS NULL AND
         "v4BodyDigestKeyId" IS NULL AND "v4DisplayPurgedAt" IS NULL)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_body_digest_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        ("v4BodyDigest" IS NOT NULL AND "v4BodyDigest" ~ '^[a-f0-9]{64}$' AND
         "v4BodyDigestKeyId" IS NOT NULL AND length("v4BodyDigestKeyId") > 0)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_display_purge_clock_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        "v4DisplayPurgedAt" IS NULL OR
        (
            ("v4TerminalAt" IS NOT NULL OR "archivedAt" IS NOT NULL) AND
            "v4DisplayPurgedAt" >= (
                CASE WHEN "v4TerminalAt" IS NOT NULL AND "archivedAt" IS NOT NULL
                    THEN LEAST("v4TerminalAt", "archivedAt")
                    ELSE COALESCE("v4TerminalAt", "archivedAt") END
                + INTERVAL '90 days'
            )
        )
    ) NOT VALID;

-- The original check assumed title ciphertext could never be purged. Replace
-- only that v4-specific check; all legacy checks and source rows remain.
ALTER TABLE "AmuxWorkItem"
    DROP CONSTRAINT "AmuxWorkItem_v4_key_pair_check",
    ADD CONSTRAINT "AmuxWorkItem_v4_key_pair_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        (
            (
                ("v4DisplayPurgedAt" IS NULL AND
                 "v4TitleCiphertext" IS NOT NULL AND "v4TitleKeyId" IS NOT NULL AND
                 length("v4TitleKeyId") > 0 AND "v4TitleKeyVersion" IS NOT NULL AND
                 "v4TitleKeyVersion" > 0 AND
                 "v4BodyCiphertext" IS NOT NULL AND "v4BodyKeyId" IS NOT NULL AND
                 length("v4BodyKeyId") > 0 AND "v4BodyKeyVersion" IS NOT NULL AND
                 "v4BodyKeyVersion" > 0) OR
                ("v4DisplayPurgedAt" IS NOT NULL AND
                 "v4TitleCiphertext" IS NULL AND "v4TitleKeyId" IS NULL AND
                 "v4TitleKeyVersion" IS NULL AND
                 "v4BodyCiphertext" IS NULL AND "v4BodyKeyId" IS NULL AND
                 "v4BodyKeyVersion" IS NULL AND
                 ("status" IN ('done', 'cancelled') OR "archivedAt" IS NOT NULL))
            ) AND
            (
                ("cardType" = 'story' AND "v4BriefCiphertext" IS NULL AND
                 "v4BriefKeyId" IS NULL AND "v4BriefKeyVersion" IS NULL AND
                 "v4BriefDigest" IS NULL AND "v4BriefDigestKeyId" IS NULL AND
                 "v4BriefPurgedAt" IS NULL) OR
                ("cardType" = 'task' AND (
                    ("v4BriefPurgedAt" IS NULL AND "v4BriefCiphertext" IS NOT NULL AND
                     "v4BriefKeyId" IS NOT NULL AND length("v4BriefKeyId") > 0 AND
                     "v4BriefKeyVersion" IS NOT NULL AND "v4BriefKeyVersion" > 0) OR
                    ("v4BriefPurgedAt" IS NOT NULL AND "v4BriefCiphertext" IS NULL AND
                     "v4BriefKeyId" IS NULL AND "v4BriefKeyVersion" IS NULL AND
                     "status" IN ('done', 'cancelled') AND "v4TerminalAt" IS NOT NULL)
                ))
            )
        )
    ) NOT VALID;

CREATE FUNCTION amux_v4_card_display_purge_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    db_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."sourceSystem" = 'admin-idea-v4' AND
           (NEW."status" <> 'backlog' OR NEW."archivedAt" IS NOT NULL OR
            NEW."v4TerminalAt" IS NOT NULL OR NEW."v4DisplayPurgedAt" IS NOT NULL) THEN
            RAISE EXCEPTION 'AMUX v4 registration must start in backlog'
                USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."sourceSystem" = 'admin-idea-v4' AND
       NEW."sourceSystem" IS DISTINCT FROM OLD."sourceSystem" THEN
        RAISE EXCEPTION 'AMUX v4 card source identity is immutable'
            USING ERRCODE = 'P0001';
    END IF;
    IF NEW."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' THEN RETURN NEW; END IF;
    IF OLD."v4TerminalAt" IS NOT NULL THEN
        IF NEW."v4TerminalAt" IS DISTINCT FROM OLD."v4TerminalAt" THEN
            RAISE EXCEPTION 'AMUX v4 terminal clock is immutable' USING ERRCODE = 'P0001';
        END IF;
    ELSIF NEW."status" IN ('done', 'cancelled') THEN
        NEW."v4TerminalAt" := db_now;
    ELSIF NEW."v4TerminalAt" IS NOT NULL THEN
        RAISE EXCEPTION 'AMUX v4 terminal clock requires terminal status'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."archivedAt" IS NOT NULL THEN
        IF NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" THEN
            RAISE EXCEPTION 'AMUX v4 archive clock is immutable' USING ERRCODE = 'P0001';
        END IF;
    ELSIF NEW."archivedAt" IS NOT NULL THEN
        NEW."archivedAt" := db_now;
    END IF;
    IF OLD."v4DisplayPurgedAt" IS NOT NULL THEN
        IF NEW."v4DisplayPurgedAt" IS DISTINCT FROM OLD."v4DisplayPurgedAt" OR
           NEW."v4TitleCiphertext" IS NOT NULL OR NEW."v4BodyCiphertext" IS NOT NULL OR
           NEW."v4TitleKeyId" IS NOT NULL OR NEW."v4BodyKeyId" IS NOT NULL THEN
            RAISE EXCEPTION 'AMUX v4 purged card display cannot be restored'
                USING ERRCODE = 'P0001';
        END IF;
    ELSIF NEW."v4DisplayPurgedAt" IS NOT NULL THEN
        NEW."v4DisplayPurgedAt" := db_now;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxWorkItem_v4_display_purge_fence"
BEFORE INSERT OR UPDATE ON "AmuxWorkItem"
FOR EACH ROW EXECUTE FUNCTION amux_v4_card_display_purge_fence();
