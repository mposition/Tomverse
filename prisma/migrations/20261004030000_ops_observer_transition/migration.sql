-- The sre-ops agent's transition ledger (docs/policy/sre-ops.md §3 rules 7,
-- 8 and 10, §10).
--
-- Every state advance appends one row naming the system audit entry written
-- in the same transaction, so the trust check reads the generations since its
-- checkpoint with a primary-key range seek instead of filtering audit metadata.
-- No row is written and nothing is turned on. What the database owns:
--
--   1. A row is the advance of its own transaction: its generation is the one
--      the state row of its genesis holds, that state row was written by this
--      transaction (its xmin is ours), and keysSha256 is the stamp the state
--      trigger computed. A superseded genesis cannot append.
--   2. No generation is skipped: generation 1 starts a genesis's ledger and
--      every later row follows the previous one. Deletion keeps the row at the
--      verified checkpoint and everything after it (rule 4), so "the previous
--      row exists" is the whole rule; there is no purged gap to allow for.
--   3. The row names the audit entry of this same advance: written by this
--      transaction (its xmin is ours), by the system actor ops-observer, as
--      ops_observer.state_advanced of this genesis, with this generation and
--      key stamp in its metadata, and signed; the row copies its hash. An entry
--      committed by an earlier advance therefore cannot be bound to a later
--      one. The id is a plain column, not a foreign key: AdminAuditLog already
--      refuses UPDATE and DELETE of every row
--      (20260918090000_admin_audit_log_append_only), so a restricting key
--      would repeat that rule, and it would add a relation to the audit
--      table's schema block that other features fingerprint.
--   4. Rows never change and the table is never truncated. A row is deleted
--      only seven years after it was written (the guard sets createdAt, so a
--      caller cannot backdate it), only below its genesis's verified
--      checkpoint, and only while the ledger row at that checkpoint exists. A
--      state advance that appended no row is a trust-check failure (T3c), and
--      this last condition keeps such a lag from letting the checkpoint vouch
--      for generations the ledger never held. Deleting the ledger of a
--      superseded genesis needs the retirement record of a later slice; until
--      it exists that delete is refused, which is the conservative direction
--      (a row kept, never a row lost). The ledger never holds an audit row
--      back: it has no key into the audit table (rule 3).
--   5. A claimed run deadline is required and at most 180 s ahead, and the
--      deferred constraint trigger of the genesis and state migration aborts
--      the COMMIT of a row written past it. The limit stated there about
--      SET CONSTRAINTS applies here unchanged.
--
-- The guard locks the genesis FOR SHARE before it looks and refuses any
-- isolation level but READ COMMITTED, for the reason the genesis and state
-- migration gives. It pins search_path to pg_catalog, pg_temp and reaches
-- tables only through the schema of the table that fired it.

BEGIN;

CREATE TABLE "OpsObserverTransition" (
    "genesisId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "auditEntryHash" TEXT NOT NULL,
    "keysSha256" TEXT NOT NULL,
    "runDeadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsObserverTransition_pkey" PRIMARY KEY ("genesisId", "generation")
);

ALTER TABLE "OpsObserverTransition"
    ADD CONSTRAINT "OpsObserverTransition_genesisId_fkey" FOREIGN KEY ("genesisId")
        REFERENCES "OpsObserverGenesis"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "OpsObserverTransition_auditLogId_key" UNIQUE ("auditLogId"),
    ADD CONSTRAINT "OpsObserverTransition_generation_check" CHECK ("generation" >= 1),
    ADD CONSTRAINT "OpsObserverTransition_keysSha256_check" CHECK ("keysSha256" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION ops_observer_transition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  superseded     boolean;
  state_gen      integer;
  state_keys     text;
  state_ours     boolean;
  verified_gen   integer;
  previous_found boolean;
  audit_hash     text;
  audit_action   text;
  audit_type     text;
  audit_target   text;
  audit_no_user  boolean;
  audit_actor    text;
  audit_generation text;
  audit_keys     text;
  audit_ours     boolean;
  checkpoint_found boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ops_observer_transition_immutable' USING ERRCODE = 'OB070';
  END IF;

  -- Every path that reads the genesis chain below needs a fresh snapshot after
  -- its lock, which only READ COMMITTED gives (see the state migration).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ops_observer_isolation_not_read_committed' USING ERRCODE = 'OB040';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Lock first, then look: a genesis replacing this one holds the row FOR
    -- UPDATE until it commits, so a delete either waits and then sees it, or
    -- holds the share lock and makes the replacement wait for the delete.
    EXECUTE format('SELECT 1 FROM %I."OpsObserverGenesis" WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA)
      USING OLD."genesisId";
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."OpsObserverGenesis" WHERE "supersedesGenesisId" = $1)',
                   TG_TABLE_SCHEMA)
      INTO superseded USING OLD."genesisId";
    EXECUTE format('SELECT s."verifiedThroughGeneration",
                           EXISTS (SELECT 1 FROM %1$I.%2$I t
                                    WHERE t."genesisId" = s."genesisId" AND t.generation = s."verifiedThroughGeneration")
                      FROM %1$I."OpsObserverState" s WHERE s."genesisId" = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO verified_gen, checkpoint_found USING OLD."genesisId";
    IF superseded THEN
      RAISE EXCEPTION 'ops_observer_transition_superseded' USING ERRCODE = 'OB072';
    END IF;
    IF OLD."createdAt" >= clock_timestamp() - interval '7 years'
       OR verified_gen IS NULL OR verified_gen <= OLD."generation" THEN
      RAISE EXCEPTION 'ops_observer_transition_retained' USING ERRCODE = 'OB071';
    END IF;
    IF NOT checkpoint_found THEN
      RAISE EXCEPTION 'ops_observer_transition_checkpoint_missing' USING ERRCODE = 'OB076';
    END IF;
    RETURN OLD;
  END IF;

  -- Lock first, then look, as the state guard does.
  EXECUTE format('SELECT 1 FROM %I."OpsObserverGenesis" WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA)
    USING NEW."genesisId";
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."OpsObserverGenesis" WHERE "supersedesGenesisId" = $1)',
                 TG_TABLE_SCHEMA)
    INTO superseded USING NEW."genesisId";
  IF superseded THEN
    RAISE EXCEPTION 'ops_observer_transition_superseded' USING ERRCODE = 'OB072';
  END IF;

  -- xmin is this transaction's id only if this transaction wrote the state
  -- row (inside a savepoint it is the subtransaction's, and the store opens
  -- none).
  EXECUTE format('SELECT generation, "stampKeysSha256", xmin = pg_current_xact_id()::xid
                    FROM %I."OpsObserverState" WHERE "genesisId" = $1 FOR SHARE', TG_TABLE_SCHEMA)
    INTO state_gen, state_keys, state_ours USING NEW."genesisId";
  IF state_gen IS NULL OR NOT state_ours OR NEW."generation" <> state_gen
     OR NEW."keysSha256" IS DISTINCT FROM state_keys THEN
    RAISE EXCEPTION 'ops_observer_transition_not_this_advance' USING ERRCODE = 'OB073';
  END IF;

  IF NEW."generation" > 1 THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "genesisId" = $1 AND generation = $2)',
                   TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO previous_found USING NEW."genesisId", NEW."generation" - 1;
    IF NOT previous_found THEN
      RAISE EXCEPTION 'ops_observer_transition_gap' USING ERRCODE = 'OB074';
    END IF;
  END IF;

  -- The audit entry of this advance: written by this transaction, by the
  -- ops-observer system actor, naming this genesis, generation and key stamp.
  EXECUTE format('SELECT "entryHash", action, "targetType", "targetId", "actorUserId" IS NULL,
                         metadata ->> ''systemActor'', metadata ->> ''generation'', metadata ->> ''keysSha256'',
                         xmin = pg_current_xact_id()::xid
                    FROM %I."AdminAuditLog" WHERE id = $1 FOR KEY SHARE', TG_TABLE_SCHEMA)
    INTO audit_hash, audit_action, audit_type, audit_target, audit_no_user,
         audit_actor, audit_generation, audit_keys, audit_ours
    USING NEW."auditLogId";
  IF audit_hash IS NULL OR NEW."auditEntryHash" IS DISTINCT FROM audit_hash
     OR audit_ours IS NOT TRUE OR audit_no_user IS NOT TRUE
     OR audit_actor IS DISTINCT FROM 'ops-observer'
     OR audit_action IS DISTINCT FROM 'ops_observer.state_advanced'
     OR audit_type IS DISTINCT FROM 'OpsObserverState'
     OR audit_target IS DISTINCT FROM NEW."genesisId"::text
     OR audit_generation IS DISTINCT FROM NEW."generation"::text
     OR audit_keys IS DISTINCT FROM NEW."keysSha256" THEN
    RAISE EXCEPTION 'ops_observer_transition_audit_mismatch' USING ERRCODE = 'OB075';
  END IF;

  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING NEW."runDeadlineAt";
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER "OpsObserverTransition_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverTransition"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_transition_guard();

-- TRUNCATE fires no row trigger, so it would bypass the delete rule above.
CREATE FUNCTION ops_observer_transition_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ops_observer_transition_retained' USING ERRCODE = 'OB071';
END $$;

CREATE TRIGGER "OpsObserverTransition_no_truncate"
    BEFORE TRUNCATE ON "OpsObserverTransition"
    FOR EACH STATEMENT EXECUTE FUNCTION ops_observer_transition_no_truncate();

CREATE CONSTRAINT TRIGGER ops_observer_transition_deadline_check
    AFTER INSERT ON "OpsObserverTransition"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check();

COMMIT;
