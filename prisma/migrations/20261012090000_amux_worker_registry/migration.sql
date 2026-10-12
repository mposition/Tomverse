-- Orchestration policy version 31 (docs/policy/development-agent-orchestration.md,
-- "버전 31"), stage R1: the worker registry and the three tables the system
-- will write. Additive only: four new tables, four functions and four
-- triggers. No existing row, column or constraint changes, and nothing here
-- writes a row.
--
-- AmuxWorkerRegistryEvent is the registry (section 3): an append-only list of
-- a person's events, and a worker's desired state is its newest event, the one
-- with the highest "sequence". What the database enforces:
--
-- * The name is the class prefix and 1-24 of [a-z0-9]; the class is the
--   name's prefix and never changes.
-- * The role ceiling is one of version 16's three roles, and an unverified
--   class (cursor, copilot) never holds contract (section 2's table).
-- * "revision" is the worker's previous revision plus one (1 for the first
--   event), compared under a transaction advisory lock on the worker, so a
--   change made over a revision the person did not see is refused.
-- * The change rule (lib/amux/workerRegistryCore.ts holds the same rule):
--     - a first event is 'requested', or 'active' only for the seven workers
--       already in the assignment catalog (R1's registration);
--     - nothing follows 'retired', so a name is never reused;
--     - no later event makes a worker 'active' that was not: activation is
--       section 5's, R5, which needs trial evidence this table cannot see;
--     - a wider role is allowed only while the worker is 'requested'.
-- * Every event names an AdminAuditLog row (foreign key, ON DELETE RESTRICT,
--   unique) that this very transaction wrote by the same person, with no
--   system marker, targeting this event: amux.worker.register for the first
--   event, amux.worker.change for any later one. The system never writes the
--   registry (section 3; foundation principle 6).
-- * "createdAt" is the database clock of the insert; UPDATE and DELETE are
--   refused; the guard runs only under READ COMMITTED, the one isolation
--   level in which its read after the lock sees what the lock waited for.
--
-- Who may write is the owner role with a recent step-up. The database cannot
-- see the role (it comes from configuration); the route checks it.
--
-- AmuxWorkerObservation (section 4), AmuxWorkerTrialEvidence (section 5) and
-- AmuxWorkerLatchEvent (section 7) are the system's append-only tables. Their
-- writers are R4 and R5, which have not been reviewed yet, so their guards
-- refuse every INSERT as well as every UPDATE and DELETE: the tables exist and
-- are read (an empty latch table is "no latch", an empty observation table is
-- "no observation", which is never assignable), and nothing can write them
-- until a later migration replaces the guard with the reviewed rule. Their
-- CHECKs hold what version 31 already decides: only 'ok' observations count,
-- a trial is one of three with outcome passed, failed or unknown and a cost
-- that is unknown (NULL) rather than zero when not known, and a latch is
-- opened by the system and released by a person under its own audit.
--
-- TRUNCATE is not refused, as with the AMUX Decision Maker tables: it fires
-- no row trigger, the application has no TRUNCATE anywhere
-- (scripts/check-protected-table-writers-core.mjs refuses one), and the DB
-- integration suites reset AdminAuditLog with TRUNCATE ... CASCADE.
--
-- Every function pins search_path to pg_catalog, pg_temp and reads tables
-- through TG_TABLE_SCHEMA, so nothing earlier on a session's path can stand in
-- for them.
--
-- `prisma db push` creates the tables and none of the functions, triggers or
-- CHECKs. The DB integration suite runs on the migration history, which is
-- where the guards are tested (tests/integration/amux-worker-registry.db.test.ts).
--
-- Rollback: drop the four triggers, the four functions, then the four tables
-- (their foreign keys go with them; AdminAuditLog is not changed). That
-- discards the registry's history. Until R2 nothing assigns from it: the
-- assignment catalog is still TOMVERSE_AMUX_WORKER_CATALOG_JSON.

BEGIN;

CREATE TABLE "AmuxWorkerRegistryEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "workerName" TEXT NOT NULL,
    "providerClass" TEXT NOT NULL,
    "roleCeiling" TEXT NOT NULL,
    "desiredState" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkerRegistryEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxWorkerRegistryEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxWorkerRegistryEvent_worker_name_check"
      CHECK ("workerName" ~ '^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$'),
    CONSTRAINT "AmuxWorkerRegistryEvent_provider_class_check"
      CHECK ("providerClass" IN ('claude', 'codex', 'cursor', 'copilot')),
    CONSTRAINT "AmuxWorkerRegistryEvent_name_class_check"
      CHECK (pg_catalog.starts_with("workerName", "providerClass" || '-')),
    CONSTRAINT "AmuxWorkerRegistryEvent_role_ceiling_check"
      CHECK ("roleCeiling" IN ('chore', 'implementation', 'contract')),
    -- Section 2: Cursor and Copilot are unverified and reach implementation.
    CONSTRAINT "AmuxWorkerRegistryEvent_class_ceiling_check"
      CHECK ("providerClass" IN ('claude', 'codex') OR "roleCeiling" IN ('chore', 'implementation')),
    CONSTRAINT "AmuxWorkerRegistryEvent_desired_state_check"
      CHECK ("desiredState" IN ('requested', 'active', 'paused', 'retired')),
    CONSTRAINT "AmuxWorkerRegistryEvent_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "AmuxWorkerRegistryEvent_actor_user_check" CHECK (pg_catalog.length("actorUserId") > 0)
);

CREATE UNIQUE INDEX "AmuxWorkerRegistryEvent_sequence_key"
  ON "AmuxWorkerRegistryEvent"("sequence");
CREATE UNIQUE INDEX "AmuxWorkerRegistryEvent_auditLogId_key"
  ON "AmuxWorkerRegistryEvent"("auditLogId");
CREATE UNIQUE INDEX "AmuxWorkerRegistryEvent_workerName_revision_key"
  ON "AmuxWorkerRegistryEvent"("workerName", "revision");
CREATE INDEX "AmuxWorkerRegistryEvent_workerName_sequence_idx"
  ON "AmuxWorkerRegistryEvent"("workerName", "sequence");

ALTER TABLE "AmuxWorkerRegistryEvent"
  ADD CONSTRAINT "AmuxWorkerRegistryEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "amux_worker_registry_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    previous_sequence BIGINT;
    previous_class TEXT;
    previous_role TEXT;
    previous_state TEXT;
    previous_revision INTEGER;
    expected_action TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_IMMUTABLE';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_ISOLATION';
    END IF;

    -- One insert per worker at a time, so the newest event read below is
    -- still the newest when this one commits.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-registry:' || NEW."workerName")
    );
    -- A separate statement after the lock: under READ COMMITTED it reads what
    -- a transaction the lock waited for has committed.
    EXECUTE pg_catalog.format(
        'SELECT "sequence", "providerClass", "roleCeiling", "desiredState", "revision" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerRegistryEvent'
    ) INTO previous_sequence, previous_class, previous_role, previous_state, previous_revision
      USING NEW."workerName";

    IF previous_sequence IS NULL THEN
        IF NEW."revision" <> 1 THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_STALE_REVISION';
        END IF;
        IF NOT (
            NEW."desiredState" = 'requested'
            OR (
                NEW."desiredState" = 'active'
                AND NEW."workerName" IN (
                    'claude-chore', 'claude-contract', 'claude-impl', 'claude-review',
                    'codex-chore', 'codex-contract', 'codex-impl'
                )
            )
        ) THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_FIRST_STATE';
        END IF;
        expected_action := 'amux.worker.register';
    ELSE
        IF NEW."sequence" <= previous_sequence THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_OUT_OF_ORDER';
        END IF;
        IF NEW."revision" <> previous_revision + 1 THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_STALE_REVISION';
        END IF;
        IF NEW."providerClass" <> previous_class THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_CLASS_CHANGED';
        END IF;
        IF previous_state = 'retired' THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_RETIRED';
        END IF;
        IF NEW."desiredState" = 'active' AND previous_state <> 'active' THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_ACTIVATION';
        END IF;
        IF pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], NEW."roleCeiling")
             > pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], previous_role)
           AND NEW."desiredState" <> 'requested' THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_ROLE_WIDENING';
        END IF;
        expected_action := 'amux.worker.change';
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", expected_action, 'AmuxWorkerRegistryEvent', NEW."id", NEW."actorUserId";
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_worker_registry_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxWorkerRegistryEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_worker_registry_event_guard"();

-- Section 4: what the reconciler and the invariant monitor observed. R4.
CREATE TABLE "AmuxWorkerObservation" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "workerName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkerObservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxWorkerObservation_worker_name_check"
      CHECK ("workerName" ~ '^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$'),
    CONSTRAINT "AmuxWorkerObservation_status_check"
      CHECK ("status" IN ('ok', 'not_ready', 'stopped', 'halted', 'drift'))
);

CREATE UNIQUE INDEX "AmuxWorkerObservation_sequence_key"
  ON "AmuxWorkerObservation"("sequence");
CREATE INDEX "AmuxWorkerObservation_workerName_sequence_idx"
  ON "AmuxWorkerObservation"("workerName", "sequence");

-- Section 5(1): one row per trial card. R5.
CREATE TABLE "AmuxWorkerTrialEvidence" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "workerName" TEXT NOT NULL,
    "trialNumber" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "costMicroUsd" BIGINT,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkerTrialEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxWorkerTrialEvidence_worker_name_check"
      CHECK ("workerName" ~ '^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$'),
    -- Activation gate 2: three trial cards per worker.
    CONSTRAINT "AmuxWorkerTrialEvidence_trial_number_check"
      CHECK ("trialNumber" BETWEEN 1 AND 3),
    CONSTRAINT "AmuxWorkerTrialEvidence_outcome_check"
      CHECK ("outcome" IN ('passed', 'failed', 'unknown')),
    -- Unknown cost is NULL, never zero; a known cost is within the US$5 cap.
    CONSTRAINT "AmuxWorkerTrialEvidence_cost_check"
      CHECK ("costMicroUsd" IS NULL OR "costMicroUsd" BETWEEN 0 AND 5000000)
);

CREATE UNIQUE INDEX "AmuxWorkerTrialEvidence_sequence_key"
  ON "AmuxWorkerTrialEvidence"("sequence");
CREATE UNIQUE INDEX "AmuxWorkerTrialEvidence_auditLogId_key"
  ON "AmuxWorkerTrialEvidence"("auditLogId");
CREATE INDEX "AmuxWorkerTrialEvidence_workerName_sequence_idx"
  ON "AmuxWorkerTrialEvidence"("workerName", "sequence");

ALTER TABLE "AmuxWorkerTrialEvidence"
  ADD CONSTRAINT "AmuxWorkerTrialEvidence_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Section 7: the automatic stop latch. The system opens it; only a person
-- releases it, under amux.worker.latch_released in the same transaction. R4.
CREATE TABLE "AmuxWorkerLatchEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "workerName" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkerLatchEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxWorkerLatchEvent_worker_name_check"
      CHECK ("workerName" ~ '^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$'),
    CONSTRAINT "AmuxWorkerLatchEvent_event_kind_check"
      CHECK ("eventKind" IN ('opened', 'released')),
    CONSTRAINT "AmuxWorkerLatchEvent_actor_kind_check"
      CHECK ("actorKind" IN ('system', 'human')),
    CONSTRAINT "AmuxWorkerLatchEvent_actor_check"
      CHECK (
        ("eventKind" = 'opened' AND "actorKind" = 'system' AND "actorUserId" IS NULL)
        OR ("eventKind" = 'released' AND "actorKind" = 'human' AND pg_catalog.length("actorUserId") > 0)
      )
);

CREATE UNIQUE INDEX "AmuxWorkerLatchEvent_sequence_key"
  ON "AmuxWorkerLatchEvent"("sequence");
CREATE UNIQUE INDEX "AmuxWorkerLatchEvent_auditLogId_key"
  ON "AmuxWorkerLatchEvent"("auditLogId");
CREATE INDEX "AmuxWorkerLatchEvent_workerName_sequence_idx"
  ON "AmuxWorkerLatchEvent"("workerName", "sequence");

ALTER TABLE "AmuxWorkerLatchEvent"
  ADD CONSTRAINT "AmuxWorkerLatchEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Closed until R4 and R5 replace these with their reviewed writer rules.
CREATE OR REPLACE FUNCTION "amux_worker_observation_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'AMUX_WORKER_OBSERVATION_CLOSED';
END;
$$;

CREATE TRIGGER "amux_worker_observation_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxWorkerObservation"
    FOR EACH ROW EXECUTE FUNCTION "amux_worker_observation_guard"();

CREATE OR REPLACE FUNCTION "amux_worker_trial_evidence_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'AMUX_WORKER_TRIAL_EVIDENCE_CLOSED';
END;
$$;

CREATE TRIGGER "amux_worker_trial_evidence_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxWorkerTrialEvidence"
    FOR EACH ROW EXECUTE FUNCTION "amux_worker_trial_evidence_guard"();

CREATE OR REPLACE FUNCTION "amux_worker_latch_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'AMUX_WORKER_LATCH_CLOSED';
END;
$$;

CREATE TRIGGER "amux_worker_latch_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxWorkerLatchEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_worker_latch_event_guard"();

COMMIT;
