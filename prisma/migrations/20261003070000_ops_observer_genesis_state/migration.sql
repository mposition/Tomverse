-- The sre-ops agent's genesis and state tables (docs/policy/sre-ops.md §3
-- rules 3, 8 and 9, §6, §8).
--
-- No row is written and nothing is turned on: the first genesis is an Admin
-- action at S1a. What the database owns here, because the store cannot be the
-- only thing holding it:
--
--   1. A genesis is a chain. The first one has no predecessor and is shadow;
--      every later one names the current head as the one it replaces, in the
--      same mode for a recovery and shadow-to-live for the one activation.
--      `supersedesGenesisId` is unique, so a head is replaced at most once, and
--      `rootMarker` (1 on the first genesis, NULL otherwise) is unique, so
--      there is one first genesis. A plain unique index rather than a partial
--      one, because `prisma db push` does not create partial indexes.
--   2. Genesis rows never change and are never deleted.
--   3. A state row starts at generation 0 and every update is exactly the next
--      generation of the same genesis -- the conditional update is the
--      compare-and-set. A superseded genesis's state cannot advance. The
--      verified checkpoint never moves backwards and never passes the
--      generation it was written against. State rows are never deleted.
--   4. The triggers write the stamps (invariant version, generation, a sha256
--      of the keys and of the checkpoint), so a write that bypassed them
--      leaves stamps that do not match.
--   5. A late run is not recorded as a success. A claimed deadline must be
--      present and at most 180 s ahead of the database clock (policy §6), and
--      a deferred constraint trigger aborts the COMMIT of a genesis or state
--      write evaluated after that deadline. A session can move a deferrable
--      check earlier with SET CONSTRAINTS ... IMMEDIATE, and any session that
--      can run SQL in the transaction could equally disable the trigger, so
--      the database cannot hold this against the code that writes: no source
--      file may issue SET CONSTRAINTS (tests/opsObserverNoSetConstraints), and
--      policy §6 item 5 requires the store, written in a later slice, to
--      re-check the deadline in its own short transaction before it reports
--      success. This migration installs neither of those; it states the limit.
--   6. A state write and a genesis replacing the genesis it belongs to are
--      serialised: the genesis insert locks the head FOR UPDATE, and the state
--      guard locks its own genesis FOR SHARE before asking whether it has been
--      superseded, so whichever commits second sees the first. That second
--      look is a fresh snapshot only under READ COMMITTED -- REPEATABLE READ
--      and SERIALIZABLE keep the transaction's first snapshot and would miss a
--      replacement that committed while the lock was awaited -- so both guards
--      refuse any other isolation level.
--
-- Trigger functions pin search_path to pg_catalog, pg_temp and reach tables
-- only through the schema of the table that fired them, so a session's
-- temporary table cannot stand in for the real one.

BEGIN;

CREATE TABLE "OpsObserverGenesis" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "supersedesGenesisId" UUID,
    "rootMarker" INTEGER,
    "requestDigest" TEXT NOT NULL,
    "invariantVersion" INTEGER NOT NULL,
    "runDeadlineAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsObserverGenesis_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OpsObserverGenesis"
    ADD CONSTRAINT "OpsObserverGenesis_supersedesGenesisId_key" UNIQUE ("supersedesGenesisId"),
    ADD CONSTRAINT "OpsObserverGenesis_rootMarker_key" UNIQUE ("rootMarker"),
    -- reasons: GENESIS_REASONS
    ADD CONSTRAINT "OpsObserverGenesis_reason_check"
        CHECK ("reason" IN ('initial', 'recovery', 'activation')),
    -- modes: GENESIS_MODES
    ADD CONSTRAINT "OpsObserverGenesis_mode_check"
        CHECK ("mode" IN ('shadow', 'live')),
    ADD CONSTRAINT "OpsObserverGenesis_root_check"
        CHECK (("supersedesGenesisId" IS NULL AND "rootMarker" = 1)
               OR ("supersedesGenesisId" IS NOT NULL AND "rootMarker" IS NULL)),
    ADD CONSTRAINT "OpsObserverGenesis_requestDigest_check"
        CHECK ("requestDigest" ~ '^[0-9a-f]{64}$');

CREATE TABLE "OpsObserverState" (
    "genesisId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "keys" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invariantVersion" INTEGER NOT NULL,
    "stampGeneration" INTEGER NOT NULL,
    "stampKeysSha256" TEXT NOT NULL,
    "verifiedThroughGeneration" INTEGER NOT NULL DEFAULT 0,
    "verifiedThroughAuditId" TEXT,
    "verifiedThroughAuditHash" TEXT,
    "stampCheckpointSha256" TEXT NOT NULL,
    "runDeadlineAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsObserverState_pkey" PRIMARY KEY ("genesisId")
);

ALTER TABLE "OpsObserverState"
    ADD CONSTRAINT "OpsObserverState_genesisId_fkey" FOREIGN KEY ("genesisId")
        REFERENCES "OpsObserverGenesis"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "OpsObserverState_generation_check" CHECK ("generation" >= 0),
    ADD CONSTRAINT "OpsObserverState_keys_check" CHECK (jsonb_typeof("keys") = 'object'),
    ADD CONSTRAINT "OpsObserverState_checkpoint_check"
        CHECK (("verifiedThroughGeneration" = 0
                AND "verifiedThroughAuditId" IS NULL AND "verifiedThroughAuditHash" IS NULL)
               OR ("verifiedThroughGeneration" > 0
                AND "verifiedThroughAuditId" IS NOT NULL AND "verifiedThroughAuditHash" IS NOT NULL));

-- The claim every deadline-carrying row passes on the way in.
CREATE FUNCTION ops_observer_deadline_claim(claimed timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF claimed IS NULL THEN
    RAISE EXCEPTION 'ops_observer_deadline_missing' USING ERRCODE = 'OB010';
  END IF;
  IF claimed > clock_timestamp() + interval '180 seconds' THEN
    RAISE EXCEPTION 'ops_observer_deadline_too_far' USING ERRCODE = 'OB011';
  END IF;
END $$;

-- Evaluated at COMMIT: a write whose run is past its deadline does not commit.
CREATE FUNCTION ops_observer_deadline_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF clock_timestamp() > NEW."runDeadlineAt" THEN
    RAISE EXCEPTION 'ops_observer_late_commit' USING ERRCODE = 'OB012';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION ops_observer_genesis_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head_id   uuid;
  head_mode text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ops_observer_genesis_immutable' USING ERRCODE = 'OB020';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ops_observer_isolation_not_read_committed' USING ERRCODE = 'OB040';
  END IF;

  NEW."createdAt"        := clock_timestamp();
  NEW."invariantVersion" := 1;
  NEW."rootMarker"       := CASE WHEN NEW."supersedesGenesisId" IS NULL THEN 1 ELSE NULL END;
  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING NEW."runDeadlineAt";

  -- The head is the genesis nobody has replaced. Locking it serialises two
  -- genesis requests; the unique on supersedesGenesisId refuses the loser.
  EXECUTE format(
    'SELECT g.id, g.mode FROM %1$I.%2$I g
      WHERE NOT EXISTS (SELECT 1 FROM %1$I.%2$I s WHERE s."supersedesGenesisId" = g.id)
      FOR UPDATE', TG_TABLE_SCHEMA, TG_TABLE_NAME)
    INTO head_id, head_mode;

  IF NEW."reason" = 'initial' THEN
    IF head_id IS NOT NULL OR NEW."supersedesGenesisId" IS NOT NULL OR NEW."mode" <> 'shadow' THEN
      RAISE EXCEPTION 'ops_observer_genesis_transition' USING ERRCODE = 'OB021';
    END IF;
  ELSE
    IF head_id IS NULL OR NEW."supersedesGenesisId" IS DISTINCT FROM head_id THEN
      RAISE EXCEPTION 'ops_observer_genesis_not_head' USING ERRCODE = 'OB022';
    END IF;
    IF NEW."reason" = 'recovery' AND NEW."mode" <> head_mode THEN
      RAISE EXCEPTION 'ops_observer_genesis_transition' USING ERRCODE = 'OB021';
    END IF;
    IF NEW."reason" = 'activation' AND NOT (head_mode = 'shadow' AND NEW."mode" = 'live') THEN
      RAISE EXCEPTION 'ops_observer_genesis_transition' USING ERRCODE = 'OB021';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "OpsObserverGenesis_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverGenesis"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_genesis_guard();

CREATE CONSTRAINT TRIGGER ops_observer_genesis_deadline_check
    AFTER INSERT ON "OpsObserverGenesis"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check();

CREATE FUNCTION ops_observer_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  superseded boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ops_observer_state_not_deletable' USING ERRCODE = 'OB030';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ops_observer_isolation_not_read_committed' USING ERRCODE = 'OB040';
  END IF;

  -- Lock first, then look: a genesis replacing this one holds its row FOR
  -- UPDATE until it commits, and the EXISTS below is a new snapshot taken
  -- after the lock is granted, so it sees that genesis if it committed.
  EXECUTE format('SELECT 1 FROM %I."OpsObserverGenesis" WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA)
    USING NEW."genesisId";
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."OpsObserverGenesis" WHERE "supersedesGenesisId" = $1)',
                 TG_TABLE_SCHEMA)
    INTO superseded USING NEW."genesisId";
  IF superseded THEN
    RAISE EXCEPTION 'ops_observer_state_superseded' USING ERRCODE = 'OB031';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."generation" <> 0 OR NEW."verifiedThroughGeneration" <> 0
       OR NEW."verifiedThroughAuditId" IS NOT NULL THEN
      RAISE EXCEPTION 'ops_observer_state_initial_shape' USING ERRCODE = 'OB032';
    END IF;
  ELSE
    IF NEW."genesisId" <> OLD."genesisId" OR NEW."generation" <> OLD."generation" + 1 THEN
      RAISE EXCEPTION 'ops_observer_state_not_next_generation' USING ERRCODE = 'OB033';
    END IF;
    IF NEW."verifiedThroughGeneration" < OLD."verifiedThroughGeneration"
       OR NEW."verifiedThroughGeneration" > OLD."generation" THEN
      RAISE EXCEPTION 'ops_observer_state_checkpoint_order' USING ERRCODE = 'OB034';
    END IF;
    -- The audit row a checkpoint names moves only with the checkpoint.
    IF NEW."verifiedThroughGeneration" = OLD."verifiedThroughGeneration"
       AND (NEW."verifiedThroughAuditId" IS DISTINCT FROM OLD."verifiedThroughAuditId"
            OR NEW."verifiedThroughAuditHash" IS DISTINCT FROM OLD."verifiedThroughAuditHash") THEN
      RAISE EXCEPTION 'ops_observer_state_checkpoint_order' USING ERRCODE = 'OB034';
    END IF;
  END IF;

  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING NEW."runDeadlineAt";

  NEW."updatedAt"             := clock_timestamp();
  NEW."invariantVersion"      := 1;
  NEW."stampGeneration"       := NEW."generation";
  NEW."stampKeysSha256"       := encode(sha256(convert_to(NEW."keys"::text, 'UTF8')), 'hex');
  NEW."stampCheckpointSha256" := encode(sha256(convert_to(
      NEW."verifiedThroughGeneration"::text || ':' ||
      coalesce(NEW."verifiedThroughAuditId", '') || ':' ||
      coalesce(NEW."verifiedThroughAuditHash", ''), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER "OpsObserverState_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverState"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_state_guard();

CREATE CONSTRAINT TRIGGER ops_observer_state_deadline_check
    AFTER INSERT OR UPDATE ON "OpsObserverState"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check();

COMMIT;
