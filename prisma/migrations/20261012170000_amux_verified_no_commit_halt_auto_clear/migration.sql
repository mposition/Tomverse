-- Orchestration policy version 32: a halt may close automatically only when
-- the same admitted write is locked and already proven to have committed no
-- state change. Existing human clears are labelled without changing their
-- actor or audit evidence. No halt, admission, receipt or audit is deleted.

BEGIN;

ALTER TABLE "AmuxOrchestratorHalt"
  ADD COLUMN "clearKind" TEXT,
  ADD COLUMN "clearEvidenceAuditLogId" TEXT;

-- The version 20 trigger rejects every update of a cleared row. Replace it in
-- this transaction so the one-time label backfill can run before the stricter
-- version 32 trigger is installed.
DROP TRIGGER "amux_orchestrator_halt_guard" ON "AmuxOrchestratorHalt";

UPDATE "AmuxOrchestratorHalt"
SET "clearKind" = 'human'
WHERE "clearedAt" IS NOT NULL;

ALTER TABLE "AmuxOrchestratorHalt"
  DROP CONSTRAINT "AmuxOrchestratorHalt_clear_triple_check",
  ADD CONSTRAINT "AmuxOrchestratorHalt_clear_kind_check"
    CHECK ("clearKind" IS NULL OR "clearKind" IN ('human', 'system_no_commit')),
  ADD CONSTRAINT "AmuxOrchestratorHalt_clear_shape_check"
    CHECK (
      (
        "clearedAt" IS NULL AND
        "clearKind" IS NULL AND
        "clearedByUserId" IS NULL AND
        "clearAuditLogId" IS NULL AND
        "clearEvidenceAuditLogId" IS NULL
      ) OR (
        "clearedAt" IS NOT NULL AND
        "clearKind" IS NOT NULL AND
        "clearAuditLogId" IS NOT NULL AND
        (
          (
            "clearKind" = 'human' AND
            "clearedByUserId" IS NOT NULL AND
            "clearEvidenceAuditLogId" IS NULL
          ) OR (
            "clearKind" = 'system_no_commit' AND
            "clearedByUserId" IS NULL AND
            "clearEvidenceAuditLogId" IS NOT NULL
          )
        )
      )
    );

CREATE UNIQUE INDEX "AmuxOrchestratorHalt_clearEvidenceAuditLogId_key"
  ON "AmuxOrchestratorHalt"("clearEvidenceAuditLogId");

CREATE OR REPLACE FUNCTION "amux_orchestrator_halt_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    present BOOLEAN;
    write_resolution TEXT;
    write_resolved_at TIMESTAMPTZ;
    write_acked_at TIMESTAMPTZ;
    write_call_kind TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."clearedAt" IS NOT NULL
           OR NEW."clearKind" IS NOT NULL
           OR NEW."clearedByUserId" IS NOT NULL
           OR NEW."clearAuditLogId" IS NOT NULL
           OR NEW."clearEvidenceAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_INSERTED_CLEARED';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "action" = $1 AND "targetId" = $2)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO present USING 'amux.orchestrator.halted', NEW."id";
        IF NOT present THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_UNAUDITED';
        END IF;
        NEW."openedAt" := pg_catalog.clock_timestamp();
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_RETAINED';
    END IF;

    IF OLD."clearedAt" IS NOT NULL
       OR OLD."clearKind" IS NOT NULL
       OR OLD."clearedByUserId" IS NOT NULL
       OR OLD."clearAuditLogId" IS NOT NULL
       OR OLD."clearEvidenceAuditLogId" IS NOT NULL THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEARED_ONCE';
    END IF;
    IF NEW."clearedAt" IS NULL
       OR NEW."clearKind" IS NULL
       OR NEW."clearAuditLogId" IS NULL THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEAR_INCOMPLETE';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."haltKey" IS DISTINCT FROM OLD."haltKey"
       OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_IMMUTABLE';
    END IF;

    IF NEW."clearKind" = 'human' THEN
        IF NEW."clearedByUserId" IS NULL OR NEW."clearEvidenceAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_HUMAN_CLEAR_INVALID';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetId" = $3 AND "actorUserId" = $4)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO present USING NEW."clearAuditLogId", 'amux.orchestrator.halt_cleared', OLD."id", NEW."clearedByUserId";
        IF NOT present THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEAR_UNAUDITED';
        END IF;
    ELSIF NEW."clearKind" = 'system_no_commit' THEN
        IF NEW."clearedByUserId" IS NOT NULL
           OR NEW."clearEvidenceAuditLogId" IS NULL
           OR OLD."requestId" IS NULL
           OR OLD."haltKey" IS DISTINCT FROM OLD."requestId"
           OR OLD."reasonCode" NOT IN (
             'claim_outcome_unknown',
             'recovery_outcome_unknown',
             'promotion_outcome_unknown'
           ) THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_AUTO_CLEAR_NOT_ALLOWED';
        END IF;

        EXECUTE pg_catalog.format(
            'SELECT "resolution", "resolvedAt", "ackedAt", "callKind" FROM %I.%I WHERE "requestId" = $1 FOR SHARE',
            TG_TABLE_SCHEMA,
            'AmuxOrchestratorWrite'
        ) INTO write_resolution, write_resolved_at, write_acked_at, write_call_kind USING OLD."requestId";
        IF write_resolution IS DISTINCT FROM 'no_commit'
           OR write_resolved_at IS NULL
           OR write_acked_at IS NOT NULL THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_AUTO_CLEAR_EVIDENCE_MISSING';
        END IF;

        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "requestId" = $1)',
            TG_TABLE_SCHEMA,
            'AmuxOrchestratorWriteReceipt'
        ) INTO present USING OLD."requestId";
        IF present THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_AUTO_CLEAR_HAS_RECEIPTS';
        END IF;

        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetId" = $3 AND "actorUserId" IS NULL AND "metadata"->>''systemActor'' = $4 AND "metadata"->>''request_id'' = $3 AND "metadata"->>''call_kind'' = $5 AND "metadata"->>''resolution'' = ''no_commit'')',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO present USING NEW."clearEvidenceAuditLogId", 'amux.orchestrator.write_resolved', OLD."requestId", 'tomverse-amux-orchestrator', write_call_kind;
        IF NOT present THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_AUTO_CLEAR_EVIDENCE_UNAUDITED';
        END IF;

        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetId" = $3 AND "actorUserId" IS NULL AND "metadata"->>''systemActor'' = $4 AND "metadata"->>''request_id'' = $5 AND "metadata"->>''resolution'' = ''no_commit'' AND "metadata"->>''clear_kind'' = ''system_no_commit'' AND "metadata"->>''evidence_audit_id'' = $6 AND "metadata"->>''halt_id'' = $3 AND "metadata"->>''halt_key'' = $7 AND "metadata"->>''reason_code'' = $8 AND "metadata"->>''call_kind'' = $9)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO present USING NEW."clearAuditLogId", 'amux.orchestrator.halt_auto_cleared', OLD."id", 'tomverse-amux-orchestrator', OLD."requestId", NEW."clearEvidenceAuditLogId", OLD."haltKey", OLD."reasonCode", write_call_kind;
        IF NOT present THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_AUTO_CLEAR_UNAUDITED';
        END IF;
    ELSE
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEAR_KIND_INVALID';
    END IF;

    NEW."clearedAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_orchestrator_halt_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorHalt"
    FOR EACH ROW EXECUTE FUNCTION "amux_orchestrator_halt_guard"();

COMMIT;
