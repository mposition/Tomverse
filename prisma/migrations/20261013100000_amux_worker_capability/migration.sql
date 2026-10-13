-- Orchestration policy version 35 (docs/policy/development-agent-orchestration.md,
-- "버전 35"), stage R2a: the worker capability events. Additive only: one new
-- table, one function and one trigger. No existing row, column or constraint
-- changes, and nothing here writes a row.
--
-- AmuxWorkerCapabilityEvent is an append-only list of a person's events; a
-- worker's capability is its newest event. What the database enforces (the
-- same rules as lib/amux/workerCapabilityCore.ts):
--
-- * The worker has a registry event, and its newest is not 'retired'.
-- * The routing tags are 1 to 64 distinct values from version 35's closed
--   list. A tag never exceeds the worker's current role ceiling: implementation
--   needs implementation or contract; contract, architecture and security need
--   contract; review needs a verified class (claude, codex).
-- * The tools are at most 16 distinct values of 1 to 64 characters.
-- * A v22 one-shot profile is all or nothing: a Claude-class worker only, a
--   claude-* model, 1 to 4 distinct roles from the closed list and 1 to 2
--   distinct tools from repo_read and repo_write, each role's own tool present
--   (implement needs repo_write; design, investigate and review repo_read), and
--   each role within the ceiling (investigate any; implement implementation;
--   design contract; review a verified class).
-- * "revision" is the worker's previous capability revision plus one, under a
--   transaction advisory lock taken after the registry's own lock for the
--   same worker, so a ceiling change and a capability write never interleave.
-- * Every event names an AdminAuditLog row (foreign key, ON DELETE RESTRICT,
--   unique) that this very transaction wrote by the same person, with no
--   system marker, under amux.worker.capability, targeting this event.
-- * "createdAt" is the database clock; UPDATE and DELETE are refused; the
--   guard runs only under READ COMMITTED.
--
-- Who may write is the owner role with a recent step-up; the route checks it.
-- TRUNCATE is not refused, as with the registry table (20261012100000).
--
-- `prisma db push` creates the table and none of the function, trigger or
-- CHECKs; the guard is tested on the migration history
-- (tests/integration/amux-worker-capability.db.test.ts).
--
-- Rollback: drop the trigger, the function, then the table. Until R2c nothing
-- reads it for assignment.

BEGIN;

CREATE TABLE "AmuxWorkerCapabilityEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "workerName" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "model" TEXT,
    "routingTags" TEXT[] NOT NULL,
    "toolCapabilities" TEXT[] NOT NULL,
    "v22Model" TEXT,
    "v22Roles" TEXT[],
    "v22Tools" TEXT[],
    "actorUserId" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxWorkerCapabilityEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxWorkerCapabilityEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxWorkerCapabilityEvent_worker_name_check"
      CHECK ("workerName" ~ '^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$'),
    CONSTRAINT "AmuxWorkerCapabilityEvent_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "AmuxWorkerCapabilityEvent_model_check"
      CHECK ("model" IS NULL OR pg_catalog.length("model") BETWEEN 1 AND 160),
    CONSTRAINT "AmuxWorkerCapabilityEvent_routing_tags_check"
      CHECK (
        pg_catalog.cardinality("routingTags") BETWEEN 1 AND 64
        AND "routingTags" <@ ARRAY['architecture', 'bugfix', 'chore', 'contract', 'fallback', 'implementation', 'integration', 'long_running', 'multi_file', 'reasoning', 'review', 'security', 'tests']::TEXT[]
      ),
    CONSTRAINT "AmuxWorkerCapabilityEvent_tools_check"
      CHECK (pg_catalog.cardinality("toolCapabilities") <= 16),
    CONSTRAINT "AmuxWorkerCapabilityEvent_v22_shape_check"
      CHECK (
        ("v22Model" IS NULL AND "v22Roles" IS NULL AND "v22Tools" IS NULL)
        OR (
          -- Spelled out: a NULL inside the comparisons below would make the
          -- whole branch NULL, and a NULL CHECK passes.
          "v22Model" IS NOT NULL AND "v22Roles" IS NOT NULL AND "v22Tools" IS NOT NULL
          AND "v22Model" ~ '^claude-[A-Za-z0-9._-]{1,120}$'
          AND pg_catalog.cardinality("v22Roles") BETWEEN 1 AND 4
          AND "v22Roles" <@ ARRAY['design', 'implement', 'investigate', 'review']::TEXT[]
          AND pg_catalog.cardinality("v22Tools") BETWEEN 1 AND 2
          AND "v22Tools" <@ ARRAY['repo_read', 'repo_write']::TEXT[]
        )
      ),
    CONSTRAINT "AmuxWorkerCapabilityEvent_actor_user_check" CHECK (pg_catalog.length("actorUserId") > 0)
);

CREATE UNIQUE INDEX "AmuxWorkerCapabilityEvent_sequence_key"
  ON "AmuxWorkerCapabilityEvent"("sequence");
CREATE UNIQUE INDEX "AmuxWorkerCapabilityEvent_auditLogId_key"
  ON "AmuxWorkerCapabilityEvent"("auditLogId");
CREATE UNIQUE INDEX "AmuxWorkerCapabilityEvent_workerName_revision_key"
  ON "AmuxWorkerCapabilityEvent"("workerName", "revision");
CREATE INDEX "AmuxWorkerCapabilityEvent_workerName_sequence_idx"
  ON "AmuxWorkerCapabilityEvent"("workerName", "sequence");

ALTER TABLE "AmuxWorkerCapabilityEvent"
  ADD CONSTRAINT "AmuxWorkerCapabilityEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "amux_worker_capability_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    registry_class TEXT;
    registry_ceiling TEXT;
    registry_state TEXT;
    previous_sequence BIGINT;
    previous_revision INTEGER;
    ceiling_rank INTEGER;
    verified BOOLEAN;
    tag TEXT;
    role TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_IMMUTABLE';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_ISOLATION';
    END IF;

    -- The registry's lock first (its guard takes the same key), then this
    -- table's: a ceiling change and a capability write never interleave.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-registry:' || NEW."workerName")
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-capability:' || NEW."workerName")
    );

    EXECUTE pg_catalog.format(
        'SELECT "providerClass", "roleCeiling", "desiredState" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerRegistryEvent'
    ) INTO registry_class, registry_ceiling, registry_state USING NEW."workerName";
    IF registry_class IS NULL THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_NOT_REGISTERED';
    END IF;
    IF registry_state = 'retired' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_RETIRED';
    END IF;
    ceiling_rank := pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], registry_ceiling);
    verified := registry_class IN ('claude', 'codex');

    IF pg_catalog.cardinality(NEW."routingTags") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."routingTags") AS t)
       OR pg_catalog.cardinality(NEW."toolCapabilities") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."toolCapabilities") AS t)
       OR (NEW."v22Roles" IS NOT NULL AND pg_catalog.cardinality(NEW."v22Roles") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."v22Roles") AS t))
       OR (NEW."v22Tools" IS NOT NULL AND pg_catalog.cardinality(NEW."v22Tools") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."v22Tools") AS t)) THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_DUPLICATE';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW."toolCapabilities") AS t WHERE pg_catalog.length(t) NOT BETWEEN 1 AND 64) THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TOOLS';
    END IF;

    FOREACH tag IN ARRAY NEW."routingTags" LOOP
        IF tag = 'implementation' AND ceiling_rank < 2 THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_CEILING';
        END IF;
        IF tag IN ('contract', 'architecture', 'security') AND ceiling_rank < 3 THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_CEILING';
        END IF;
        IF tag = 'review' AND NOT verified THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_VERIFIED';
        END IF;
    END LOOP;

    IF NEW."v22Roles" IS NOT NULL THEN
        IF registry_class <> 'claude' THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_CLASS';
        END IF;
        FOREACH role IN ARRAY NEW."v22Roles" LOOP
            IF role = 'implement' AND (ceiling_rank < 2 OR NOT ('repo_write' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'design' AND (ceiling_rank < 3 OR NOT ('repo_read' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'investigate' AND NOT ('repo_read' = ANY (NEW."v22Tools")) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'review' AND (NOT verified OR NOT ('repo_read' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
        END LOOP;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT "sequence", "revision" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerCapabilityEvent'
    ) INTO previous_sequence, previous_revision USING NEW."workerName";
    IF NEW."revision" <> COALESCE(previous_revision, 0) + 1 THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_STALE_REVISION';
    END IF;
    IF previous_sequence IS NOT NULL AND NEW."sequence" <= previous_sequence THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_OUT_OF_ORDER';
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", 'amux.worker.capability', 'AmuxWorkerCapabilityEvent', NEW."id", NEW."actorUserId";
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_worker_capability_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxWorkerCapabilityEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_worker_capability_event_guard"();

COMMIT;
