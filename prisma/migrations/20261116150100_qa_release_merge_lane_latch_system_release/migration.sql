-- Owner decision 2026-11-16 (conversation): the merge lane releases its own
-- latch on develop once it read again what latched it
-- (docs/policy/qa-release-agent.md section 8 item 5,
-- lib/qaReleaseMergeLaneLatchCore.ts qaReleaseMergeLaneSystemReleasable).
-- Until now only a person released it, whatever the reason.
--
-- A release audited by the qa-release-merge-lane system actor, with the
-- action qa_release.merge_lane_system_released and targeting the release
-- event itself, is accepted only when, in the same snapshot:
--
-- * no attempt is open;
-- * at least one set event follows the last release, and every one of them
--   has a reason the lane reads again (merge_result_unknown, deploy_failed,
--   deploy_unknown, deploy_wait_exceeded, deploy_unreadable,
--   result_not_reported) and names an attempt that closed on an outcome the
--   lane read (deployed, deploy_failed, merge_refused, not_merged);
-- * the release names no attempt.
--
-- merged_off_develop, merge_commit_off_develop and revision_mismatch stay a
-- person's, as does every release of a latch an attempt a person resolved
-- named. Whether dev deploys cleanly is the lane's own Railway reading, which
-- the database cannot see. Everything else in the function is unchanged: the
-- consecutive numbering, releasing only a latched lane, the same-transaction
-- audit row, a set event by the lane, a person's release, the database clock.
-- No table, constraint or row changes.
--
-- Rollback: CREATE OR REPLACE the function with the body of
-- 20261004020000_qa_release_merge_lane_latch (only a person releases again).
-- baseline-check: replace-function-if-body-sha256 "qa_release_merge_lane_latch_before_insert" "7153672145897c50456cc00504398b2cf1c7ed28027478a87fe3983f2e841006" "fb50e4f2d5fea4b56bb7ffb018b1939f82b410c1de231711f70d6e83bdf75729"
BEGIN;

CREATE OR REPLACE FUNCTION qa_release_merge_lane_latch_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  newest_sequence INTEGER;
  newest_latched BOOLEAN;
  audit_ok BOOLEAN;
  system_release BOOLEAN;
  releasable BOOLEAN;
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

  -- audit_ok: a set event by the lane, or a release by a person.
  -- system_release: a release by the lane itself, judged below.
  EXECUTE format(
    'SELECT
       bool_or(CASE WHEN $3
                 THEN "actorUserId" IS NULL AND "metadata"->>''systemActor'' = ''qa-release-merge-lane''
                 ELSE "actorUserId" IS NOT NULL
               END),
       bool_or(NOT $3 AND "actorUserId" IS NULL AND "metadata"->>''systemActor'' = ''qa-release-merge-lane''
               AND "targetType" = ''QaReleaseMergeLaneLatch''
               AND "action" = ''qa_release.merge_lane_system_released'')
       FROM %I."AdminAuditLog"
      WHERE "id" = $1
        AND (("targetType" = ''QaReleaseMergeLaneLatch'' AND "targetId" = $2
              AND "action" LIKE ''qa\_release.merge\_lane\_%%'')
             OR ($4 IS NOT NULL AND "targetType" = ''QaReleaseMergeAttempt'' AND "targetId" = $4
              AND "action" IN (''qa_release.merge_attempt_reported'', ''qa_release.merge_attempt_resolved'')))
        AND xmin = pg_current_xact_id()::xid',
    TG_TABLE_SCHEMA)
    INTO audit_ok, system_release
    USING NEW."auditLogId", NEW."sequence"::text, NEW."latched", NEW."attemptId";

  IF coalesce(system_release, false) THEN
    EXECUTE format(
      'SELECT NOT EXISTS (SELECT 1 FROM %1$I."QaReleaseMergeAttempt" WHERE "state" <> ''closed'')
          AND EXISTS (
            SELECT 1 FROM %1$I."QaReleaseMergeLaneLatch" l
             WHERE l."latched"
               AND l."sequence" > (SELECT coalesce(max("sequence"), 0) FROM %1$I."QaReleaseMergeLaneLatch" WHERE NOT "latched"))
          AND NOT EXISTS (
            SELECT 1 FROM %1$I."QaReleaseMergeLaneLatch" l
              LEFT JOIN %1$I."QaReleaseMergeAttempt" a ON a."id" = l."attemptId"
             WHERE l."latched"
               AND l."sequence" > (SELECT coalesce(max("sequence"), 0) FROM %1$I."QaReleaseMergeLaneLatch" WHERE NOT "latched")
               AND (l."reason" IS NULL
                    OR l."reason" NOT IN (''merge_result_unknown'', ''deploy_failed'', ''deploy_unknown'',
                                          ''deploy_wait_exceeded'', ''deploy_unreadable'', ''result_not_reported'')
                    OR a."id" IS NULL
                    OR a."state" IS DISTINCT FROM ''closed''
                    OR a."outcome" IS NULL
                    OR a."outcome" NOT IN (''deployed'', ''deploy_failed'', ''merge_refused'', ''not_merged'')))',
      TG_TABLE_SCHEMA)
      INTO releasable;
    IF NEW."attemptId" IS NOT NULL OR NOT coalesce(releasable, false) THEN
      RAISE EXCEPTION 'QaReleaseMergeLaneLatch: the lane releases only a latch whose every cause it read again and closed'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT coalesce(audit_ok, false) THEN
    RAISE EXCEPTION 'QaReleaseMergeLaneLatch events are audited in the same transaction: set by the merge lane, released by a person or by the lane'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

COMMIT;
