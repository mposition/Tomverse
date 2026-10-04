-- The QA-release merge lane's attempts (QaReleaseMergeAttempt,
-- docs/policy/qa-release-agent.md version 4, sections 3, 8 item 5 and 10):
-- one row per instruction the app issues, kept open from issue until the
-- staging deployment's outcome is known.
--
-- What the database enforces, rather than the application:
--
-- * At most one open attempt (issued, consumed or awaiting_deploy) across
--   the lane: a partial unique index, so two overlapping rounds that both
--   read the lane as free cannot both hold an attempt.
-- * The lifecycle is the table in lib/qaReleaseMergeAttemptCore.ts and
--   nothing else: every other change of state is refused, closed is
--   terminal, and the outcome is set exactly when the state becomes closed.
-- * The instruction's binding (pull request, head SHA, base develop, the
--   operator control revision) and its two-minute expiry never change after
--   insert; a consume after the expiry is refused by the database clock.
-- * The merge commit is set exactly once, on the move to awaiting_deploy,
--   and is present from then on.
-- * While awaiting deploy, the lane may record what it observed of the
--   staging deployments without moving the attempt -- the same list again
--   included; only the lane, and only that column.
-- * Every insert and every change is audited in the same transaction:
--   "lastAuditLogId" must name an AdminAuditLog row this very transaction
--   wrote, targeting this attempt. Outcomes a person records come from a
--   person (actorUserId set); every other write comes from the
--   qa-release-merge-lane system actor.
-- * Timestamps come from the database clock.
-- * Nothing is deleted or truncated.
--
-- The trigger functions pin search_path to pg_catalog, pg_temp and reach the
-- tables through TG_TABLE_SCHEMA. `prisma db push` creates the table and none
-- of the triggers; the DB integration suite runs on the migration history.
--
-- Rollback: drop the triggers, the functions, then the table. No attempt
-- exists until the lane's routes are deployed and switched on.

BEGIN;

CREATE TABLE "QaReleaseMergeAttempt" (
    "id" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "controlRevision" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" TEXT,
    "mergeCommitSha" TEXT,
    "lastAuditLogId" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployObservation" JSONB,
    "deployObservedAt" TIMESTAMPTZ(3),

    CONSTRAINT "QaReleaseMergeAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QaReleaseMergeAttempt_controlRevision_fkey"
      FOREIGN KEY ("controlRevision") REFERENCES "QaReleaseOperatorControl"("revision")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "QaReleaseMergeAttempt_pull_request_check" CHECK ("pullRequestNumber" > 0),
    CONSTRAINT "QaReleaseMergeAttempt_head_sha_check" CHECK ("headSha" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "QaReleaseMergeAttempt_base_check" CHECK ("base" = 'develop'),
    CONSTRAINT "QaReleaseMergeAttempt_state_check"
      CHECK ("state" IN ('issued', 'consumed', 'awaiting_deploy', 'closed')),
    CONSTRAINT "QaReleaseMergeAttempt_outcome_check"
      CHECK ("outcome" IS NULL OR "outcome" IN (
        'deployed', 'deploy_failed', 'merge_refused', 'not_merged', 'merged_off_develop',
        'person_not_merged', 'person_deployed', 'person_restored')),
    CONSTRAINT "QaReleaseMergeAttempt_outcome_when_closed_check"
      CHECK (("state" = 'closed') = ("outcome" IS NOT NULL) AND ("state" = 'closed') = ("closedAt" IS NOT NULL)),
    CONSTRAINT "QaReleaseMergeAttempt_merge_commit_check"
      CHECK ("mergeCommitSha" IS NULL OR "mergeCommitSha" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "QaReleaseMergeAttempt_awaiting_has_merge_commit_check"
      CHECK ("state" <> 'awaiting_deploy' OR "mergeCommitSha" IS NOT NULL),
    CONSTRAINT "QaReleaseMergeAttempt_consumed_has_time_check"
      CHECK ("state" <> 'consumed' OR "consumedAt" IS NOT NULL),
    -- The staging deployments the lane last observed for this merge: an array
    -- of at most 20 entries (the shape is checked by the app's schema).
    CONSTRAINT "QaReleaseMergeAttempt_deploy_observation_check"
      CHECK ("deployObservation" IS NULL
             OR (jsonb_typeof("deployObservation") = 'array' AND jsonb_array_length("deployObservation") <= 20)),
    CONSTRAINT "QaReleaseMergeAttempt_deploy_observed_at_check"
      CHECK (("deployObservation" IS NULL) = ("deployObservedAt" IS NULL))
);

-- One open attempt per lane. "base" is always develop (a CHECK above), so
-- this is one open attempt for the whole lane.
CREATE UNIQUE INDEX "QaReleaseMergeAttempt_one_open_per_base_key"
  ON "QaReleaseMergeAttempt" ("base")
  WHERE "state" IN ('issued', 'consumed', 'awaiting_deploy');

CREATE INDEX "QaReleaseMergeAttempt_issuedAt_idx" ON "QaReleaseMergeAttempt"("issuedAt");

-- The audit row this transaction wrote for this attempt: a person for the
-- outcomes only a person records, the merge-lane system actor for the rest.
CREATE FUNCTION qa_release_merge_attempt_audited(schema_name TEXT, audit_id TEXT, attempt_id TEXT, by_person BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I."AdminAuditLog"
        WHERE "id" = $1
          AND "targetType" = ''QaReleaseMergeAttempt''
          AND "targetId" = $2
          AND "action" LIKE ''qa\_release.merge\_attempt\_%%''
          AND xmin = pg_current_xact_id()::xid
          AND CASE WHEN $3
                THEN "actorUserId" IS NOT NULL
                ELSE "actorUserId" IS NULL AND "metadata"->>''systemActor'' = ''qa-release-merge-lane''
              END)',
    schema_name)
    INTO ok
    USING audit_id, attempt_id, by_person;
  RETURN ok;
END;
$$;

CREATE FUNCTION qa_release_merge_attempt_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  IF NEW."state" <> 'issued' OR NEW."outcome" IS NOT NULL OR NEW."mergeCommitSha" IS NOT NULL
     OR NEW."deployObservation" IS NOT NULL OR NEW."deployObservedAt" IS NOT NULL
     OR NEW."consumedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt rows start as issued'
      USING ERRCODE = 'check_violation';
  END IF;
  -- search_path is pinned, so the helper is reached through the table's schema.
  EXECUTE format('SELECT %I.qa_release_merge_attempt_audited($1, $2, $3, $4)', TG_TABLE_SCHEMA)
    INTO ok USING TG_TABLE_SCHEMA::text, NEW."lastAuditLogId", NEW."id", false;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt rows are audited by the merge lane in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."issuedAt" := clock_timestamp();
  NEW."expiresAt" := NEW."issuedAt" + interval '2 minutes';
  NEW."updatedAt" := NEW."issuedAt";
  RETURN NEW;
END;
$$;

CREATE FUNCTION qa_release_merge_attempt_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  allowed BOOLEAN;
  by_person BOOLEAN;
  ok BOOLEAN;
  ok_person BOOLEAN;
  observation_only BOOLEAN := false;
  now_ TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."pullRequestNumber" IS DISTINCT FROM OLD."pullRequestNumber"
     OR NEW."headSha" IS DISTINCT FROM OLD."headSha"
     OR NEW."base" IS DISTINCT FROM OLD."base"
     OR NEW."controlRevision" IS DISTINCT FROM OLD."controlRevision"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt binding never changes'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The lifecycle table of lib/qaReleaseMergeAttemptCore.ts.
  allowed := CASE
    WHEN OLD."state" = 'issued' AND NEW."state" = 'consumed' THEN NEW."outcome" IS NULL
    WHEN OLD."state" = 'issued' AND NEW."state" = 'awaiting_deploy' THEN NEW."outcome" IS NULL
    WHEN OLD."state" = 'issued' AND NEW."state" = 'closed'
      THEN NEW."outcome" IN ('not_merged', 'merged_off_develop', 'person_not_merged')
    WHEN OLD."state" = 'consumed' AND NEW."state" = 'awaiting_deploy' THEN NEW."outcome" IS NULL
    WHEN OLD."state" = 'consumed' AND NEW."state" = 'closed'
      THEN NEW."outcome" IN ('merge_refused', 'not_merged', 'merged_off_develop', 'person_not_merged')
    WHEN OLD."state" = 'awaiting_deploy' AND NEW."state" = 'closed'
      THEN NEW."outcome" IN ('deployed', 'deploy_failed', 'person_deployed', 'person_restored')
    ELSE false
  END;
  allowed := coalesce(allowed, false);
  IF NOT allowed AND NOT (OLD."state" = 'awaiting_deploy' AND NEW."state" = 'awaiting_deploy') THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt cannot move from % to %', OLD."state", NEW."state"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT allowed AND OLD."state" = 'awaiting_deploy' AND NEW."state" = 'awaiting_deploy' THEN
    -- Recording what was observed is the one same-state change, and it is the
    -- lane's: a repeated report with the same list is still a report, so the
    -- list need not differ (QA_RELEASE_MERGE_ATTEMPT_OBSERVATION_STATE).
    allowed := NEW."outcome" IS NULL AND NEW."deployObservation" IS NOT NULL
               AND NEW."mergeCommitSha" IS NOT DISTINCT FROM OLD."mergeCommitSha";
    observation_only := allowed;
    IF NOT allowed THEN
      RAISE EXCEPTION 'QaReleaseMergeAttempt cannot move from % to %', OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."state" = 'consumed' AND now_ >= OLD."expiresAt" THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt instruction expired'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The merge commit is set once, on the move to awaiting_deploy.
  IF OLD."mergeCommitSha" IS NOT NULL AND NEW."mergeCommitSha" IS DISTINCT FROM OLD."mergeCommitSha" THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt merge commit is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."mergeCommitSha" IS NULL AND NEW."mergeCommitSha" IS NOT NULL AND NEW."state" <> 'awaiting_deploy' THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt merge commit is set with the move to awaiting_deploy'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."lastAuditLogId" IS NOT DISTINCT FROM OLD."lastAuditLogId" THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt changes are audited in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A person's confirmation, and only that, comes from a person; so does a
  -- person's move of an unreported merge to awaiting_deploy, which the
  -- latch release records with no outcome.
  by_person := NEW."outcome" IN ('person_not_merged', 'person_deployed', 'person_restored');
  EXECUTE format('SELECT %I.qa_release_merge_attempt_audited($1, $2, $3, $4)', TG_TABLE_SCHEMA)
    INTO ok USING TG_TABLE_SCHEMA::text, NEW."lastAuditLogId", NEW."id", by_person;
  EXECUTE format('SELECT %I.qa_release_merge_attempt_audited($1, $2, $3, $4)', TG_TABLE_SCHEMA)
    INTO ok_person USING TG_TABLE_SCHEMA::text, NEW."lastAuditLogId", NEW."id", true;
  IF NOT (coalesce(ok, false) OR (NEW."state" = 'awaiting_deploy' AND NOT observation_only AND coalesce(ok_person, false))) THEN
    RAISE EXCEPTION 'QaReleaseMergeAttempt changes are audited by the right actor in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."consumedAt" := CASE WHEN NEW."state" = 'consumed' THEN now_ ELSE OLD."consumedAt" END;
  NEW."closedAt" := CASE WHEN NEW."state" = 'closed' THEN now_ ELSE NULL END;
  -- The time the list was last reported: a changed list, or the lane's
  -- same-state report of it, which may repeat the same list.
  NEW."deployObservedAt" := CASE
    WHEN NEW."deployObservation" IS NULL THEN NULL
    WHEN NEW."deployObservation" IS DISTINCT FROM OLD."deployObservation" OR observation_only THEN now_
    ELSE OLD."deployObservedAt"
  END;
  NEW."updatedAt" := now_;
  RETURN NEW;
END;
$$;

CREATE FUNCTION qa_release_merge_attempt_refuse_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'QaReleaseMergeAttempt rows are never removed'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "QaReleaseMergeAttempt_before_insert"
  BEFORE INSERT ON "QaReleaseMergeAttempt"
  FOR EACH ROW EXECUTE FUNCTION qa_release_merge_attempt_before_insert();

CREATE TRIGGER "QaReleaseMergeAttempt_before_update"
  BEFORE UPDATE ON "QaReleaseMergeAttempt"
  FOR EACH ROW EXECUTE FUNCTION qa_release_merge_attempt_before_update();

CREATE TRIGGER "QaReleaseMergeAttempt_before_delete"
  BEFORE DELETE ON "QaReleaseMergeAttempt"
  FOR EACH ROW EXECUTE FUNCTION qa_release_merge_attempt_refuse_removal();

CREATE TRIGGER "QaReleaseMergeAttempt_before_truncate"
  BEFORE TRUNCATE ON "QaReleaseMergeAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION qa_release_merge_attempt_refuse_removal();

COMMIT;
