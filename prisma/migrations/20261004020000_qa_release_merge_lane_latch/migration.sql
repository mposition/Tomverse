-- The QA-release merge lane's latch (QaReleaseMergeLaneLatch,
-- docs/policy/qa-release-agent.md version 4, section 8 item 5): an
-- append-only list of events. The lane is latched when the newest event sets
-- it.
--
-- What the database enforces, rather than the application:
--
-- * Events are numbered 1, 2, 3, ... with no gap, so two writers that read
--   the same newest event cannot both append after it.
-- * A set event carries one of the lane's reasons (lib/qaReleaseMergeLaneLatchCore.ts)
--   and is audited in the same transaction by the qa-release-merge-lane system
--   actor. Setting is allowed while latched: a second cause is recorded.
-- * The audit row targets either this event (a merge_lane_ action) or the
--   attempt the event names, and then only a result report's or a person's
--   resolution's action: one audit row for both writes (policy section 10's
--   statement counts), never an issue's or a consume's.
-- * A release carries no reason, follows a set event, and is audited in the
--   same transaction by a person (actorUserId set).
-- * An event may name the attempt it concerns; the attempt must exist.
-- * "createdAt" comes from the database clock.
-- * Nothing is changed or removed.
--
-- The trigger functions pin search_path to pg_catalog, pg_temp and reach the
-- tables through TG_TABLE_SCHEMA. `prisma db push` creates the table and none
-- of the triggers; the DB integration suite runs on the migration history.
--
-- Rollback: drop the triggers, the functions, then the table. The lane reads
-- "no event" as not latched, so nothing may be rolled back while the lane is
-- switched on.

BEGIN;

CREATE TABLE "QaReleaseMergeLaneLatch" (
    "sequence" INTEGER NOT NULL,
    "latched" BOOLEAN NOT NULL,
    "reason" TEXT,
    "attemptId" TEXT,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaReleaseMergeLaneLatch_pkey" PRIMARY KEY ("sequence"),
    CONSTRAINT "QaReleaseMergeLaneLatch_attemptId_fkey"
      FOREIGN KEY ("attemptId") REFERENCES "QaReleaseMergeAttempt"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "QaReleaseMergeLaneLatch_sequence_check" CHECK ("sequence" >= 1),
    CONSTRAINT "QaReleaseMergeLaneLatch_reason_check"
      CHECK ("reason" IS NULL OR "reason" IN (
        'merge_result_unknown', 'deploy_failed', 'deploy_unknown', 'deploy_wait_exceeded',
        'deploy_unreadable', 'result_not_reported', 'merged_off_develop',
        'merge_commit_off_develop', 'revision_mismatch')),
    CONSTRAINT "QaReleaseMergeLaneLatch_reason_when_set_check"
      CHECK ("latched" = ("reason" IS NOT NULL))
);

CREATE UNIQUE INDEX "QaReleaseMergeLaneLatch_auditLogId_key"
  ON "QaReleaseMergeLaneLatch"("auditLogId");

CREATE FUNCTION qa_release_merge_lane_latch_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  newest_sequence INTEGER;
  newest_latched BOOLEAN;
  audit_ok BOOLEAN;
BEGIN
  EXECUTE format(
    'SELECT "sequence", "latched" FROM %I."QaReleaseMergeLaneLatch" ORDER BY "sequence" DESC LIMIT 1',
    TG_TABLE_SCHEMA)
    INTO newest_sequence, newest_latched;
  IF NEW."sequence" IS DISTINCT FROM coalesce(newest_sequence, 0) + 1 THEN
    RAISE EXCEPTION 'QaReleaseMergeLaneLatch events are consecutive'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW."latched" AND newest_latched IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'QaReleaseMergeLaneLatch releases only a latched lane'
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I."AdminAuditLog"
        WHERE "id" = $1
          AND (("targetType" = ''QaReleaseMergeLaneLatch'' AND "targetId" = $2
                AND "action" LIKE ''qa\_release.merge\_lane\_%%'')
               OR ($4 IS NOT NULL AND "targetType" = ''QaReleaseMergeAttempt'' AND "targetId" = $4
                AND "action" IN (''qa_release.merge_attempt_reported'', ''qa_release.merge_attempt_resolved'')))
          AND xmin = pg_current_xact_id()::xid
          AND CASE WHEN $3
                THEN "actorUserId" IS NULL AND "metadata"->>''systemActor'' = ''qa-release-merge-lane''
                ELSE "actorUserId" IS NOT NULL
              END)',
    TG_TABLE_SCHEMA)
    INTO audit_ok
    USING NEW."auditLogId", NEW."sequence"::text, NEW."latched", NEW."attemptId";
  IF NOT coalesce(audit_ok, false) THEN
    RAISE EXCEPTION 'QaReleaseMergeLaneLatch events are audited in the same transaction: set by the merge lane, released by a person'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION qa_release_merge_lane_latch_refuse_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'QaReleaseMergeLaneLatch is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "QaReleaseMergeLaneLatch_before_insert"
  BEFORE INSERT ON "QaReleaseMergeLaneLatch"
  FOR EACH ROW EXECUTE FUNCTION qa_release_merge_lane_latch_before_insert();

CREATE TRIGGER "QaReleaseMergeLaneLatch_before_update"
  BEFORE UPDATE ON "QaReleaseMergeLaneLatch"
  FOR EACH ROW EXECUTE FUNCTION qa_release_merge_lane_latch_refuse_change();

CREATE TRIGGER "QaReleaseMergeLaneLatch_before_delete"
  BEFORE DELETE ON "QaReleaseMergeLaneLatch"
  FOR EACH ROW EXECUTE FUNCTION qa_release_merge_lane_latch_refuse_change();

CREATE TRIGGER "QaReleaseMergeLaneLatch_before_truncate"
  BEFORE TRUNCATE ON "QaReleaseMergeLaneLatch"
  FOR EACH STATEMENT EXECUTE FUNCTION qa_release_merge_lane_latch_refuse_change();

COMMIT;
