-- Orchestration policy version 20, "orchestrator 정지(halt)와 재시작".
-- Additive only: three new tables, three functions and three triggers. No
-- existing row, column or constraint changes, and nothing here writes a row.
--
-- AmuxOrchestratorWrite is the admission of one orchestrator write call
-- (claim, recover, automatic promotion tick). The route commits it in its own
-- short transaction before it processes the call, so a write whose answer the
-- orchestrator lost is still found after its process is gone.
-- AmuxOrchestratorWriteReceipt is written in the same transaction as each
-- state change the call commits; a rolled-back change leaves no receipt. AmuxOrchestratorHalt
-- is the orchestrator's stored halt, opened by the orchestrator and cleared
-- only by a person.
--
-- What the triggers make the database enforce, rather than the application:
--
-- * An admission's `admittedAt` is the database clock of its insert and its
--   `deadlineAt` that clock plus the budget the writer asked for (at most 60
--   seconds). The writer computes both in SQL already; the trigger re-anchors
--   them on clock_timestamp() so no Node clock can reach either column.
-- * `ackedAt` is written once. `resolvedAt` and `resolution` are written once,
--   together. `no_commit` needs the deadline plus five seconds to have passed,
--   no receipt, and the system audit `amux.orchestrator.write_resolved` for
--   the request. `human_confirmed` needs a cleared halt naming the request.
--   The identity and the two clock columns never change.
-- * A receipt is refused once its admission is acknowledged or resolved. The
--   trigger locks the admission row FOR SHARE, so it waits for a resolver or
--   an acknowledgement holding it FOR UPDATE and then sees what they wrote.
--   Receipts are never updated.
-- * An admission, and so its receipts, may be deleted only once acknowledged
--   or resolved and 90 days old. Nothing here deletes one; that is a later,
--   separate job if one is ever wanted.
-- * A halt is inserted open, with its `openedAt` on the database clock and
--   only after the system audit `amux.orchestrator.halted` naming its id
--   exists. Its three clear columns are written once, together, only with the
--   human audit `amux.orchestrator.halt_cleared` of the same administrator,
--   and every other update and every delete is refused.
--
-- `prisma db push` creates the tables and none of the functions or triggers.
-- The DB integration suite runs on the migration history
-- (scripts/run-db-integration-tests.mjs), which is where the triggers are
-- tested.
--
-- Rollback: drop the three triggers, the three functions, then the receipt,
-- admission and halt tables. Dropping them discards the halt record, so a
-- rollback is only safe with no open halt and no unresolved admission.

BEGIN;

CREATE TABLE "AmuxOrchestratorWrite" (
    "requestId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "callKind" TEXT NOT NULL,
    "admittedAt" TIMESTAMPTZ(3) NOT NULL,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "ackedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" TEXT,

    CONSTRAINT "AmuxOrchestratorWrite_pkey" PRIMARY KEY ("requestId"),
    CONSTRAINT "AmuxOrchestratorWrite_call_kind_check"
      CHECK ("callKind" IN ('claim', 'recover', 'auto_promotion_tick')),
    CONSTRAINT "AmuxOrchestratorWrite_resolution_check"
      CHECK ("resolution" IS NULL OR "resolution" IN ('no_commit', 'human_confirmed')),
    CONSTRAINT "AmuxOrchestratorWrite_resolution_pair_check"
      CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL)),
    CONSTRAINT "AmuxOrchestratorWrite_request_id_format_check"
      CHECK ("requestId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxOrchestratorWrite_instance_id_format_check"
      CHECK ("instanceId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxOrchestratorWrite_deadline_window_check"
      CHECK ("deadlineAt" > "admittedAt" AND "deadlineAt" <= "admittedAt" + INTERVAL '60 seconds')
);

CREATE INDEX "AmuxOrchestratorWrite_ackedAt_resolvedAt_deadlineAt_idx"
  ON "AmuxOrchestratorWrite"("ackedAt", "resolvedAt", "deadlineAt");

CREATE TABLE "AmuxOrchestratorWriteReceipt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT,
    "rowCount" INTEGER NOT NULL,
    "committedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AmuxOrchestratorWriteReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxOrchestratorWriteReceipt_target_kind_check"
      CHECK ("targetKind" IN (
        'work_item',
        'claim_decision',
        'execution_attempt',
        'auto_promotion_grant',
        'auto_promotion_consumption',
        'quota_observation_batch'
      )),
    CONSTRAINT "AmuxOrchestratorWriteReceipt_target_id_pair_check"
      CHECK (("targetKind" = 'quota_observation_batch') = ("targetId" IS NULL)),
    CONSTRAINT "AmuxOrchestratorWriteReceipt_target_id_length_check"
      CHECK ("targetId" IS NULL OR char_length("targetId") BETWEEN 1 AND 191),
    CONSTRAINT "AmuxOrchestratorWriteReceipt_row_count_check"
      CHECK ("rowCount" BETWEEN 1 AND 100000)
);

CREATE INDEX "AmuxOrchestratorWriteReceipt_requestId_idx"
  ON "AmuxOrchestratorWriteReceipt"("requestId");

ALTER TABLE "AmuxOrchestratorWriteReceipt"
  ADD CONSTRAINT "AmuxOrchestratorWriteReceipt_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AmuxOrchestratorWrite"("requestId") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "AmuxOrchestratorHalt" (
    "id" TEXT NOT NULL,
    "haltKey" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "requestId" TEXT,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "clearedAt" TIMESTAMPTZ(3),
    "clearedByUserId" TEXT,
    "clearAuditLogId" TEXT,

    CONSTRAINT "AmuxOrchestratorHalt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxOrchestratorHalt_reason_code_check"
      CHECK ("reasonCode" IN (
        'claim_outcome_unknown',
        'recovery_outcome_unknown',
        'promotion_outcome_unknown',
        'unacked_write_receipt',
        'contract_violation',
        'selection_read_failures'
      )),
    -- The first four reasons are about one write call and carry its request
    -- id; the last two are not and carry none.
    CONSTRAINT "AmuxOrchestratorHalt_request_pair_check"
      CHECK (
        ("reasonCode" IN (
          'claim_outcome_unknown',
          'recovery_outcome_unknown',
          'promotion_outcome_unknown',
          'unacked_write_receipt'
        )) = ("requestId" IS NOT NULL)
      ),
    CONSTRAINT "AmuxOrchestratorHalt_halt_key_request_check"
      CHECK ("requestId" IS NULL OR "haltKey" = "requestId"),
    CONSTRAINT "AmuxOrchestratorHalt_clear_triple_check"
      CHECK (
        ("clearedAt" IS NULL) = ("clearedByUserId" IS NULL) AND
        ("clearedAt" IS NULL) = ("clearAuditLogId" IS NULL)
      ),
    CONSTRAINT "AmuxOrchestratorHalt_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxOrchestratorHalt_halt_key_format_check"
      CHECK ("haltKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE UNIQUE INDEX "AmuxOrchestratorHalt_haltKey_key"
  ON "AmuxOrchestratorHalt"("haltKey");
CREATE UNIQUE INDEX "AmuxOrchestratorHalt_clearAuditLogId_key"
  ON "AmuxOrchestratorHalt"("clearAuditLogId");
CREATE INDEX "AmuxOrchestratorHalt_clearedAt_openedAt_idx"
  ON "AmuxOrchestratorHalt"("clearedAt", "openedAt");
CREATE INDEX "AmuxOrchestratorHalt_requestId_idx"
  ON "AmuxOrchestratorHalt"("requestId");

-- The other tables are read through TG_TABLE_SCHEMA, so a function never
-- depends on the caller's search_path: the tables are always the ones beside
-- the table that fired it.

CREATE OR REPLACE FUNCTION "amux_orchestrator_write_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    budget INTERVAL;
    present BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."ackedAt" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL OR NEW."resolution" IS NOT NULL THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_INSERTED_CLOSED';
        END IF;
        budget := NEW."deadlineAt" - NEW."admittedAt";
        IF budget IS NULL OR budget <= INTERVAL '0 seconds' OR budget > INTERVAL '60 seconds' THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_BUDGET_INVALID';
        END IF;
        NEW."admittedAt" := pg_catalog.clock_timestamp();
        NEW."deadlineAt" := NEW."admittedAt" + budget;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF (OLD."ackedAt" IS NULL AND OLD."resolvedAt" IS NULL)
           OR OLD."admittedAt" > pg_catalog.clock_timestamp() - INTERVAL '90 days' THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_RETAINED';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."instanceId" IS DISTINCT FROM OLD."instanceId"
       OR NEW."callKind" IS DISTINCT FROM OLD."callKind"
       OR NEW."admittedAt" IS DISTINCT FROM OLD."admittedAt"
       OR NEW."deadlineAt" IS DISTINCT FROM OLD."deadlineAt" THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_IMMUTABLE';
    END IF;

    IF OLD."ackedAt" IS NOT NULL THEN
        IF NEW."ackedAt" IS DISTINCT FROM OLD."ackedAt" THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_ACKED_ONCE';
        END IF;
    ELSIF NEW."ackedAt" IS NOT NULL THEN
        NEW."ackedAt" := pg_catalog.clock_timestamp();
    END IF;

    IF OLD."resolvedAt" IS NOT NULL THEN
        IF NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
           OR NEW."resolution" IS DISTINCT FROM OLD."resolution" THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_RESOLVED_ONCE';
        END IF;
    ELSIF NEW."resolvedAt" IS NOT NULL THEN
        IF NEW."resolution" = 'no_commit' THEN
            IF pg_catalog.clock_timestamp() < OLD."deadlineAt" + INTERVAL '5 seconds' THEN
                RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_UNDECIDED';
            END IF;
            EXECUTE pg_catalog.format(
                'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "requestId" = $1)',
                TG_TABLE_SCHEMA,
                'AmuxOrchestratorWriteReceipt'
            ) INTO present USING OLD."requestId";
            IF present THEN
                RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_HAS_RECEIPTS';
            END IF;
            EXECUTE pg_catalog.format(
                'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "action" = $1 AND "targetId" = $2)',
                TG_TABLE_SCHEMA,
                'AdminAuditLog'
            ) INTO present USING 'amux.orchestrator.write_resolved', OLD."requestId";
            IF NOT present THEN
                RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_RESOLUTION_UNAUDITED';
            END IF;
        ELSIF NEW."resolution" = 'human_confirmed' THEN
            EXECUTE pg_catalog.format(
                'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "requestId" = $1 AND "clearedAt" IS NOT NULL)',
                TG_TABLE_SCHEMA,
                'AmuxOrchestratorHalt'
            ) INTO present USING OLD."requestId";
            IF NOT present THEN
                RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_CLEAR_MISSING';
            END IF;
        END IF;
        NEW."resolvedAt" := pg_catalog.clock_timestamp();
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_orchestrator_write_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorWrite"
    FOR EACH ROW EXECUTE FUNCTION "amux_orchestrator_write_guard"();

CREATE OR REPLACE FUNCTION "amux_orchestrator_write_receipt_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    admission_open BOOLEAN;
    deletable BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        EXECUTE pg_catalog.format(
            'SELECT "ackedAt" IS NULL AND "resolvedAt" IS NULL FROM %I.%I WHERE "requestId" = $1 FOR SHARE',
            TG_TABLE_SCHEMA,
            'AmuxOrchestratorWrite'
        ) INTO admission_open USING NEW."requestId";
        IF admission_open IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_CLOSED';
        END IF;
        NEW."committedAt" := pg_catalog.clock_timestamp();
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_RECEIPT_IMMUTABLE';
    END IF;

    -- DELETE. A cascade from the admission finds no admission row and is
    -- allowed; a direct delete follows the admission's own retention rule.
    EXECUTE pg_catalog.format(
        'SELECT ("ackedAt" IS NOT NULL OR "resolvedAt" IS NOT NULL) AND "admittedAt" <= pg_catalog.clock_timestamp() - $2 FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxOrchestratorWrite'
    ) INTO deletable USING OLD."requestId", INTERVAL '90 days';
    IF deletable IS NOT NULL AND NOT deletable THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_WRITE_RECEIPT_RETAINED';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "amux_orchestrator_write_receipt_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorWriteReceipt"
    FOR EACH ROW EXECUTE FUNCTION "amux_orchestrator_write_receipt_guard"();

CREATE OR REPLACE FUNCTION "amux_orchestrator_halt_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    present BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."clearedAt" IS NOT NULL OR NEW."clearedByUserId" IS NOT NULL OR NEW."clearAuditLogId" IS NOT NULL THEN
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

    IF OLD."clearedAt" IS NOT NULL OR OLD."clearedByUserId" IS NOT NULL OR OLD."clearAuditLogId" IS NOT NULL THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEARED_ONCE';
    END IF;
    IF NEW."clearedAt" IS NULL OR NEW."clearedByUserId" IS NULL OR NEW."clearAuditLogId" IS NULL THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEAR_INCOMPLETE';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."haltKey" IS DISTINCT FROM OLD."haltKey"
       OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_IMMUTABLE';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetId" = $3 AND "actorUserId" = $4)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO present USING NEW."clearAuditLogId", 'amux.orchestrator.halt_cleared', OLD."id", NEW."clearedByUserId";
    IF NOT present THEN
        RAISE EXCEPTION 'AMUX_ORCHESTRATOR_HALT_CLEAR_UNAUDITED';
    END IF;
    NEW."clearedAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_orchestrator_halt_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorHalt"
    FOR EACH ROW EXECUTE FUNCTION "amux_orchestrator_halt_guard"();

COMMIT;
