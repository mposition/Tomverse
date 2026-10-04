-- The QA-release agent's operator control record (QaReleaseOperatorControl,
-- docs/policy/qa-release-agent.md section 6): what the operator decided --
-- which services are enabled, the develop merge-lane switch, the IaC commit to
-- apply, and when each of the agent's secrets and keys was last rotated (the
-- time only, never a value) -- as an append-only list of numbered revisions.
-- The operator sets the newest number on all three services, and the app
-- refuses any service call that names another number.
--
-- What the database enforces, rather than the application:
--
-- * Revisions are 1, 2, 3, ... with no gap: a new row must be exactly one
--   past the newest. Two operators saving at once both compute the same
--   number and the primary key admits one of them.
-- * A row is an Admin action audited in the same transaction: "auditLogId"
--   must name an AdminAuditLog row written by this very transaction, by a
--   person (actorUserId set), with action 'qa_release.control_recorded' and
--   this revision as its target.
-- * "createdAt" comes from the database clock, and no rotation time may lie
--   after it.
-- * Nothing is ever changed or removed: every UPDATE, DELETE and TRUNCATE is
--   refused.
--
-- The trigger functions pin search_path to pg_catalog, pg_temp and reach the
-- two tables through TG_TABLE_SCHEMA, so no object earlier on a session's
-- path can stand in for them.
--
-- `prisma db push` creates the table and none of the triggers. The DB
-- integration suite runs on the migration history, which is where they are
-- tested.
--
-- Rollback: drop the four triggers, the two functions, then the table. That
-- discards the operator's control history and every service call is refused
-- until a revision is recorded again.

BEGIN;

CREATE TABLE "QaReleaseOperatorControl" (
    "revision" INTEGER NOT NULL,
    "digestEnabled" BOOLEAN NOT NULL,
    "mergeLaneEnabled" BOOLEAN NOT NULL,
    "developLaneOn" BOOLEAN NOT NULL,
    "iacCommit" TEXT,
    "digestSecretRotatedAt" TIMESTAMPTZ(3),
    "monitorSecretRotatedAt" TIMESTAMPTZ(3),
    "mergeLaneSecretRotatedAt" TIMESTAMPTZ(3),
    "githubAppKeyRotatedAt" TIMESTAMPTZ(3),
    "railwayTokenRotatedAt" TIMESTAMPTZ(3),
    "githubReadTokenRotatedAt" TIMESTAMPTZ(3),
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaReleaseOperatorControl_pkey" PRIMARY KEY ("revision"),
    CONSTRAINT "QaReleaseOperatorControl_revision_check"
      CHECK ("revision" >= 1),
    CONSTRAINT "QaReleaseOperatorControl_iac_commit_check"
      CHECK ("iacCommit" IS NULL OR "iacCommit" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "QaReleaseOperatorControl_rotation_check"
      CHECK (("digestSecretRotatedAt" IS NULL OR "digestSecretRotatedAt" <= "createdAt")
         AND ("monitorSecretRotatedAt" IS NULL OR "monitorSecretRotatedAt" <= "createdAt")
         AND ("mergeLaneSecretRotatedAt" IS NULL OR "mergeLaneSecretRotatedAt" <= "createdAt")
         AND ("githubAppKeyRotatedAt" IS NULL OR "githubAppKeyRotatedAt" <= "createdAt")
         AND ("railwayTokenRotatedAt" IS NULL OR "railwayTokenRotatedAt" <= "createdAt")
         AND ("githubReadTokenRotatedAt" IS NULL OR "githubReadTokenRotatedAt" <= "createdAt"))
);

CREATE UNIQUE INDEX "QaReleaseOperatorControl_auditLogId_key"
  ON "QaReleaseOperatorControl"("auditLogId");

CREATE FUNCTION qa_release_operator_control_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  newest INTEGER;
  audit_ok BOOLEAN;
BEGIN
  EXECUTE format('SELECT max("revision") FROM %I."QaReleaseOperatorControl"', TG_TABLE_SCHEMA)
    INTO newest;
  IF NEW."revision" IS DISTINCT FROM coalesce(newest, 0) + 1 THEN
    RAISE EXCEPTION 'QaReleaseOperatorControl revisions are consecutive'
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I."AdminAuditLog"
        WHERE "id" = $1
          AND "action" = ''qa_release.control_recorded''
          AND "targetType" = ''QaReleaseOperatorControl''
          AND "targetId" = $2
          AND "actorUserId" IS NOT NULL
          AND xmin = pg_current_xact_id()::xid)',
    TG_TABLE_SCHEMA)
    INTO audit_ok
    USING NEW."auditLogId", NEW."revision"::text;
  IF NOT audit_ok THEN
    RAISE EXCEPTION 'QaReleaseOperatorControl rows are audited by a person in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION qa_release_operator_control_refuse_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'QaReleaseOperatorControl is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "QaReleaseOperatorControl_before_insert"
  BEFORE INSERT ON "QaReleaseOperatorControl"
  FOR EACH ROW EXECUTE FUNCTION qa_release_operator_control_before_insert();

CREATE TRIGGER "QaReleaseOperatorControl_before_update"
  BEFORE UPDATE ON "QaReleaseOperatorControl"
  FOR EACH ROW EXECUTE FUNCTION qa_release_operator_control_refuse_change();

CREATE TRIGGER "QaReleaseOperatorControl_before_delete"
  BEFORE DELETE ON "QaReleaseOperatorControl"
  FOR EACH ROW EXECUTE FUNCTION qa_release_operator_control_refuse_change();

CREATE TRIGGER "QaReleaseOperatorControl_before_truncate"
  BEFORE TRUNCATE ON "QaReleaseOperatorControl"
  FOR EACH STATEMENT EXECUTE FUNCTION qa_release_operator_control_refuse_change();

COMMIT;
