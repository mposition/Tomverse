-- Orchestration policy version 18, "활성화 증거": an AMUX transaction whose
-- COMMIT arrives after its deadline is refused by the database, so a late run
-- is not recorded as a success. Additive only: one new table, one function and
-- one trigger. No existing row, column or constraint changes, and nothing here
-- writes a row.
--
-- The fence that ends every AMUX mutation transaction with a deadline
-- (lib/amux/dbBoundary.ts: the mutation fence in withAmuxDbBoundary, and
-- fenceAmuxRouteDeadline for the auto-promotion tick) inserts one row here,
-- keyed by its own top-level transaction id, carrying the commit deadline D:
-- the earliest of the deadlines it is held to, less AMUX_DB_COMMIT_RESERVE_MS.
-- The fence refuses at the same D, so the two checks are one deadline.
--
-- The trigger is a deferred constraint trigger. PostgreSQL 16 and 17 run it
-- during COMMIT, before the commit record is written, and an error there rolls
-- the whole transaction back. Once the database clock has reached D the COMMIT
-- fails with SQLSTATE AX001; otherwise the trigger deletes its own row, so a
-- committed transaction leaves nothing behind and a rolled-back one never had
-- a row. The DELETE fires nothing: the trigger is AFTER INSERT only.
--
-- A statement that makes this constraint immediate would run the check at the
-- fence instead of at COMMIT, so the application never runs SET CONSTRAINTS
-- (tests/amuxCommitDeadline.test.mjs).
--
-- The function and the trigger sit between the two install markers below.
-- `prisma db push` creates the table and neither of them, so the Admin E2E
-- harness and DB_INTEGRATION_SCHEMA_SOURCE=push apply exactly that text from
-- this file (scripts/amux-commit-deadline-install.mjs). Without it the fence
-- refuses every AMUX write with AMUX_DB_COMMIT_CHECK_MISSING.
--
-- Rollback: drop the trigger, then the function, then the table. The table
-- holds no row between transactions.

BEGIN;

CREATE TABLE "AmuxCommitDeadline" (
    "txid" BIGINT NOT NULL,
    "deadline" TIMESTAMPTZ(3) NOT NULL,
    "operation" TEXT NOT NULL,

    CONSTRAINT "AmuxCommitDeadline_pkey" PRIMARY KEY ("txid")
);

-- amux-commit-deadline-check:install:begin
CREATE OR REPLACE FUNCTION "amux_commit_deadline_check"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF pg_catalog.clock_timestamp() >= NEW."deadline" THEN
        RAISE EXCEPTION 'AMUX_LATE_COMMIT' USING ERRCODE = 'AX001';
    END IF;
    EXECUTE pg_catalog.format(
        'DELETE FROM %I.%I WHERE "txid" = $1',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME
    ) USING NEW."txid";
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "amux_commit_deadline_check"
    AFTER INSERT ON "AmuxCommitDeadline"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "amux_commit_deadline_check"();
-- amux-commit-deadline-check:install:end

COMMIT;
