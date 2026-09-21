-- AMUX provenance/status expansion only. This migration imports no cards,
-- promotes no backlog rows, and does not claim ownership or start execution.
--
-- Existing AMUX rows remain in their current status. New rows default to
-- non-dispatchable backlog, so a future writer cannot accidentally create a
-- runnable Todo by omitting status. The existing CHECK proves old rows fit the
-- widened list; NOT VALID enforces new writes immediately. Validation of the
-- widened CHECK is deliberately a separate evidence-backed migration. The two
-- new checks are validated here: pre-existing rows cannot be backlog and all
-- newly added source columns are NULL for those rows.

BEGIN;

ALTER TABLE "AmuxWorkItem"
    ADD COLUMN "sourceSystem" TEXT,
    ADD COLUMN "sourceKey" TEXT,
    ADD COLUMN "sourceVersion" TEXT,
    ADD COLUMN "sourceDigest" TEXT,
    ADD COLUMN "sourceSnapshot" JSONB;

ALTER TABLE "AmuxWorkItem"
    ALTER COLUMN "status" SET DEFAULT 'backlog',
    DROP CONSTRAINT "AmuxWorkItem_status_check",
    ADD CONSTRAINT "AmuxWorkItem_status_check"
        CHECK ("status" IN (
            'backlog', 'todo', 'doing', 'review', 'done', 'blocked', 'cancelled'
        )) NOT VALID;

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_backlog_unowned_check"
        CHECK (
            "status" <> 'backlog' OR
            ("owner" IS NULL AND "claimedAt" IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_source_complete_check"
        CHECK (
            (
                "sourceSystem" IS NULL AND
                "sourceKey" IS NULL AND
                "sourceVersion" IS NULL AND
                "sourceDigest" IS NULL AND
                "sourceSnapshot" IS NULL
            ) OR (
                "sourceSystem" IS NOT NULL AND
                "sourceSystem" ~ '^[a-z][a-z0-9._-]*$' AND
                "sourceKey" IS NOT NULL AND
                "sourceKey" ~ '^[A-Z0-9][A-Z0-9._:-]*$' AND
                "sourceVersion" IS NOT NULL AND
                "sourceVersion" ~ '^[!-~]+$' AND
                "sourceDigest" IS NOT NULL AND
                "sourceDigest" ~ '^[a-f0-9]{64}$' AND
                "sourceSnapshot" IS NOT NULL AND
                jsonb_typeof("sourceSnapshot") = 'object' AND
                "sourceSnapshot" <> '{}'::jsonb
            )
        ) NOT VALID;

ALTER TABLE "AmuxWorkItem"
    VALIDATE CONSTRAINT "AmuxWorkItem_backlog_unowned_check";

ALTER TABLE "AmuxWorkItem"
    VALIDATE CONSTRAINT "AmuxWorkItem_source_complete_check";

CREATE UNIQUE INDEX "AmuxWorkItem_sourceSystem_sourceKey_key"
    ON "AmuxWorkItem"("sourceSystem", "sourceKey");

COMMIT;
