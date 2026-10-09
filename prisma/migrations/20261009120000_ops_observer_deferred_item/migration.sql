-- The sre-ops deferred items (docs/policy/sre-ops.md §1 item 3, §5, §10).
--
-- A message the daily cap holds back is not reserved, so until now nothing
-- recorded it: the key moved on, the next run no longer owed it, and neither
-- a page nor the daily digest ever showed it. The advance now writes each such
-- item here, in the transaction that moves the key, from the owed messages it
-- derives itself -- never from what the run claims. What the database owns:
--
--   1. A deferred item belongs to the current genesis and copies its mode; a
--      superseded genesis cannot defer. The guard locks the genesis FOR SHARE
--      before it looks, and refuses any isolation level but READ COMMITTED,
--      as the reservation guard does.
--   2. (mode, signal, scope, kind, openedAt) is unique, so a kind is deferred
--      at most once per incident.
--   3. Rows never change. A row is deleted only 90 days after it was written,
--      by a retention batch that names its deadline (the retention deadline
--      check, as for the reservations).
--   4. A claimed run deadline is required and at most 180 s ahead, and the
--      deferred deadline check refuses the COMMIT once the database clock is
--      past it.
--
-- Nothing is written and nothing is turned on.

BEGIN;

CREATE TABLE "OpsObserverDeferredItem" (
    "id" UUID NOT NULL,
    "genesisId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "ownerDate" DATE NOT NULL,
    "signal" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "deferredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invariantVersion" INTEGER NOT NULL,
    "runDeadlineAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsObserverDeferredItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OpsObserverDeferredItem"
    ADD CONSTRAINT "OpsObserverDeferredItem_genesisId_fkey" FOREIGN KEY ("genesisId")
        REFERENCES "OpsObserverGenesis"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "OpsObserverDeferredItem_incident_kind_key"
        UNIQUE ("mode", "signal", "scope", "kind", "openedAt"),
    -- modes: GENESIS_MODES
    ADD CONSTRAINT "OpsObserverDeferredItem_mode_check"
        CHECK ("mode" IN ('shadow', 'live')),
    -- kinds: MESSAGE_KINDS
    ADD CONSTRAINT "OpsObserverDeferredItem_kind_check"
        CHECK ("kind" IN ('new_open', 'worsening', 'reopen', 'recovery')),
    -- origins: ITEM_ORIGINS
    ADD CONSTRAINT "OpsObserverDeferredItem_origin_check"
        CHECK ("origin" IN ('new', 'reopen')),
    ADD CONSTRAINT "OpsObserverDeferredItem_signal_check"
        CHECK ("signal" ~ '^[A-Za-z][A-Za-z0-9-]{0,7}$'),
    ADD CONSTRAINT "OpsObserverDeferredItem_scope_check"
        CHECK ("scope" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$');

CREATE INDEX "OpsObserverDeferredItem_ownerDate_mode_idx" ON "OpsObserverDeferredItem"("ownerDate", "mode");

CREATE FUNCTION ops_observer_deferred_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  genesis_mode text;
  superseded   boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."deferredAt" > clock_timestamp() - interval '90 days' THEN
      RAISE EXCEPTION 'ops_observer_deferred_item_retained' USING ERRCODE = 'OB090';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ops_observer_deferred_item_immutable' USING ERRCODE = 'OB091';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ops_observer_isolation_not_read_committed' USING ERRCODE = 'OB040';
  END IF;
  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING NEW."runDeadlineAt";
  -- Lock, then look, as the reservation guard does.
  EXECUTE format('SELECT mode FROM %I."OpsObserverGenesis" WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA)
    INTO genesis_mode USING NEW."genesisId";
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."OpsObserverGenesis" WHERE "supersedesGenesisId" = $1)',
                 TG_TABLE_SCHEMA)
    INTO superseded USING NEW."genesisId";
  IF superseded THEN
    RAISE EXCEPTION 'ops_observer_deferred_item_superseded' USING ERRCODE = 'OB092';
  END IF;
  NEW."mode" := genesis_mode;
  NEW."deferredAt" := clock_timestamp();
  NEW."invariantVersion" := 1;
  RETURN NEW;
END $$;

CREATE FUNCTION ops_observer_deferred_item_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ops_observer_deferred_item_retained' USING ERRCODE = 'OB090';
END $$;

CREATE TRIGGER "OpsObserverDeferredItem_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverDeferredItem"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deferred_item_guard();

CREATE TRIGGER "OpsObserverDeferredItem_no_truncate"
    BEFORE TRUNCATE ON "OpsObserverDeferredItem"
    FOR EACH STATEMENT EXECUTE FUNCTION ops_observer_deferred_item_no_truncate();

CREATE CONSTRAINT TRIGGER ops_observer_deferred_item_deadline_check
    AFTER INSERT ON "OpsObserverDeferredItem"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check();

CREATE CONSTRAINT TRIGGER ops_observer_deferred_item_retention_deadline_check
    AFTER DELETE ON "OpsObserverDeferredItem"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_retention_deadline_check();

COMMIT;
