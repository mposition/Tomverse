-- Expand source revisions, backfill R0 from existing import columns, then
-- validate the pointer. This migration does not change source columns, card
-- status, kind, priority, owner, or execution rows.

BEGIN;

CREATE TABLE "AmuxReconciliationRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceCommit" TEXT NOT NULL,
    "boardDigest" TEXT NOT NULL,
    "manifestDigest" TEXT NOT NULL,
    "canonicalizationVersion" TEXT NOT NULL,
    "plannerVersion" TEXT NOT NULL,
    "validatorVersion" TEXT NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "scannerRulesetDigest" TEXT NOT NULL,
    "activeItemCount" INTEGER NOT NULL,
    "sectionCount" INTEGER NOT NULL,
    "itemDriftCount" INTEGER NOT NULL,
    "missingCount" INTEGER NOT NULL,
    "extraCount" INTEGER NOT NULL,
    "globalSnapshotDrift" INTEGER NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "approvalAuditLogId" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "applyingAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxReconciliationRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxReconciliationRun"
    ADD CONSTRAINT "AmuxReconciliationRun_approvalAuditLogId_key"
        UNIQUE ("approvalAuditLogId"),
    ADD CONSTRAINT "AmuxReconciliationRun_status_check"
        CHECK ("status" IN (
            'prepared',
            'approved',
            'applying',
            'consumed',
            'rejected',
            'outcome_unknown'
        )),
    ADD CONSTRAINT "AmuxReconciliationRun_digest_check"
        CHECK (
            "sourceCommit" ~ '^[a-f0-9]{40}$' AND
            "boardDigest" ~ '^[a-f0-9]{64}$' AND
            "manifestDigest" ~ '^[a-f0-9]{64}$' AND
            "scannerRulesetDigest" ~ '^[a-f0-9]{64}$'
        ),
    ADD CONSTRAINT "AmuxReconciliationRun_count_check"
        CHECK (
            "activeItemCount" >= 0 AND
            "sectionCount" >= 0 AND
            "itemDriftCount" >= 0 AND
            "missingCount" >= 0 AND
            "extraCount" >= 0 AND
            "globalSnapshotDrift" IN (0, 1)
        );

CREATE INDEX "AmuxReconciliationRun_status_expiresAt_idx"
    ON "AmuxReconciliationRun"("status", "expiresAt");
CREATE INDEX "AmuxReconciliationRun_sourceCommit_idx"
    ON "AmuxReconciliationRun"("sourceCommit");

CREATE TABLE "AmuxWorkItemSourceRevision" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "parentRevisionId" TEXT,
    "sourceVersion" TEXT NOT NULL,
    "detailDigest" TEXT NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "reconciliationRunId" TEXT,
    "state" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decisionAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkItemSourceRevision_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxWorkItemSourceRevision"
    ADD CONSTRAINT "AmuxWorkItemSourceRevision_state_check"
        CHECK ("state" IN ('observed', 'accepted', 'rejected')),
    ADD CONSTRAINT "AmuxWorkItemSourceRevision_digest_check"
        CHECK (
            "detailDigest" ~ '^[a-f0-9]{64}$' AND
            octet_length("sourceVersion") BETWEEN 1 AND 200 AND
            octet_length("sectionCode") BETWEEN 1 AND 64
        ),
    ADD CONSTRAINT "AmuxWorkItemSourceRevision_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AmuxWorkItemSourceRevision_parentRevisionId_fkey"
        FOREIGN KEY ("parentRevisionId") REFERENCES "AmuxWorkItemSourceRevision"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AmuxWorkItemSourceRevision_reconciliationRunId_fkey"
        FOREIGN KEY ("reconciliationRunId") REFERENCES "AmuxReconciliationRun"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "AmuxWorkItemSourceRevision_workItemId_createdAt_idx"
    ON "AmuxWorkItemSourceRevision"("workItemId", "createdAt");
CREATE INDEX "AmuxWorkItemSourceRevision_reconciliationRunId_idx"
    ON "AmuxWorkItemSourceRevision"("reconciliationRunId");

CREATE FUNCTION amux_source_revision_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'AmuxWorkItemSourceRevision is append-only';
END;
$$;

CREATE TRIGGER "AmuxWorkItemSourceRevision_reject_update"
BEFORE UPDATE ON "AmuxWorkItemSourceRevision"
FOR EACH ROW EXECUTE FUNCTION amux_source_revision_append_only();

CREATE TRIGGER "AmuxWorkItemSourceRevision_reject_delete"
BEFORE DELETE ON "AmuxWorkItemSourceRevision"
FOR EACH ROW EXECUTE FUNCTION amux_source_revision_append_only();

ALTER TABLE "AmuxWorkItem"
    ADD COLUMN "acceptedSourceRevisionId" TEXT;

CREATE UNIQUE INDEX "AmuxWorkItem_acceptedSourceRevisionId_key"
    ON "AmuxWorkItem"("acceptedSourceRevisionId");

INSERT INTO "AmuxWorkItemSourceRevision" (
    "id",
    "workItemId",
    "parentRevisionId",
    "sourceVersion",
    "detailDigest",
    "sectionCode",
    "reconciliationRunId",
    "state",
    "observedAt",
    "decidedAt",
    "decisionAuditLogId",
    "createdAt"
)
SELECT
    'r0_' || "id",
    "id",
    NULL,
    "sourceVersion",
    "sourceSnapshot"->>'detailDigest',
    "sourceSnapshot"->>'sectionCode',
    NULL,
    'accepted',
    "createdAt",
    "createdAt",
    NULL,
    CURRENT_TIMESTAMP
FROM "AmuxWorkItem"
WHERE "sourceSystem" IS NOT NULL;

UPDATE "AmuxWorkItem" AS item
SET "acceptedSourceRevisionId" = 'r0_' || item."id"
WHERE item."sourceSystem" IS NOT NULL;

DO $$
DECLARE
    sourced integer;
    revisions integer;
    pointed integer;
BEGIN
    SELECT count(*) INTO sourced
    FROM "AmuxWorkItem"
    WHERE "sourceSystem" IS NOT NULL;

    SELECT count(*) INTO revisions
    FROM "AmuxWorkItemSourceRevision"
    WHERE "reconciliationRunId" IS NULL
      AND "state" = 'accepted'
      AND "id" = 'r0_' || "workItemId";

    SELECT count(*) INTO pointed
    FROM "AmuxWorkItem" AS item
    JOIN "AmuxWorkItemSourceRevision" AS rev
      ON rev."id" = item."acceptedSourceRevisionId"
    WHERE item."sourceSystem" IS NOT NULL
      AND rev."workItemId" = item."id"
      AND rev."state" = 'accepted'
      AND rev."detailDigest" = item."sourceSnapshot"->>'detailDigest'
      AND rev."sectionCode" = item."sourceSnapshot"->>'sectionCode'
      AND item."sourceVersion" IS NOT DISTINCT FROM rev."sourceVersion"
      AND item."sourceDigest" = rev."detailDigest";

    IF sourced <> revisions OR sourced <> pointed THEN
        RAISE EXCEPTION 'R0 backfill mismatch sourced=% revisions=% pointed=%',
            sourced, revisions, pointed;
    END IF;
END $$;

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_acceptedSourceRevisionId_fkey"
        FOREIGN KEY ("acceptedSourceRevisionId")
        REFERENCES "AmuxWorkItemSourceRevision"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
        NOT VALID;

ALTER TABLE "AmuxWorkItem"
    VALIDATE CONSTRAINT "AmuxWorkItem_acceptedSourceRevisionId_fkey";

CREATE FUNCTION amux_work_item_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    rev_item text;
    rev_state text;
BEGIN
    IF NEW."acceptedSourceRevisionId" IS NOT NULL THEN
        SELECT "workItemId", "state"
        INTO rev_item, rev_state
        FROM "AmuxWorkItemSourceRevision"
        WHERE "id" = NEW."acceptedSourceRevisionId";
        IF rev_item IS DISTINCT FROM NEW."id" OR rev_state IS DISTINCT FROM 'accepted' THEN
            RAISE EXCEPTION 'acceptedSourceRevisionId must reference an accepted revision of this card';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND (
        NEW."sourceVersion" IS DISTINCT FROM OLD."sourceVersion" OR
        NEW."sourceDigest" IS DISTINCT FROM OLD."sourceDigest" OR
        NEW."sourceSnapshot" IS DISTINCT FROM OLD."sourceSnapshot"
    ) THEN
        RAISE EXCEPTION 'imported source fields are immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxWorkItem_source_guard"
BEFORE INSERT OR UPDATE ON "AmuxWorkItem"
FOR EACH ROW EXECUTE FUNCTION amux_work_item_source_guard();

COMMIT;
