-- The sre-ops agent's reservation tables (docs/policy/sre-ops.md §3 rules 3
-- and 9, §5, §10).
--
-- No row is written and nothing is turned on. What the database owns:
--
--   1. A reservation is created `reserved` and closed exactly once -- to
--      `confirmed` only under a live genesis, to `shadowed` only under a shadow
--      genesis, or to `abandoned`. Nothing else about it changes, except that
--      the run that closes it records its own deadline.
--   2. At most one reservation is open at a time: `reservedMarker` is 1 while
--      reserved and NULL afterwards, under a plain unique index (prisma db push
--      does not create partial ones).
--   3. A reservation belongs to the current genesis and copies its mode; a
--      superseded genesis cannot reserve. The guard locks the genesis FOR SHARE
--      before it looks, and refuses any isolation level but READ COMMITTED, for
--      the reason the genesis and state migration gives.
--   4. An item is written in the same transaction as its reservation, while it
--      is still reserved, and copies its mode. (mode, signal, scope, kind,
--      openedAt) is unique, so a kind of message is reserved at most once per
--      incident, and shadow items never take a live item's place.
--   5. Items never change. They disappear only with their reservation, and a
--      reservation is deleted only once closed for the retention period.
--   6. A claimed run deadline is required and at most 180 s ahead, and a
--      deferred constraint trigger aborts the COMMIT of a reservation written
--      or closed past it. The limit stated in the genesis and state migration
--      about SET CONSTRAINTS applies here unchanged.

BEGIN;

CREATE TABLE "OpsObserverDelivery" (
    "id" UUID NOT NULL,
    "genesisId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reservedMarker" INTEGER,
    "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(3),
    "shadowedAt" TIMESTAMPTZ(3),
    "abandonedAt" TIMESTAMPTZ(3),
    "ownerDate" DATE NOT NULL,
    "channelCheckDate" DATE,
    "digestItemId" UUID,
    "invariantVersion" INTEGER NOT NULL,
    "stampStatus" TEXT NOT NULL,
    "runDeadlineAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsObserverDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OpsObserverDelivery"
    ADD CONSTRAINT "OpsObserverDelivery_genesisId_fkey" FOREIGN KEY ("genesisId")
        REFERENCES "OpsObserverGenesis"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "OpsObserverDelivery_runId_key" UNIQUE ("runId"),
    ADD CONSTRAINT "OpsObserverDelivery_reservedMarker_key" UNIQUE ("reservedMarker"),
    ADD CONSTRAINT "OpsObserverDelivery_channelCheckDate_key" UNIQUE ("channelCheckDate"),
    -- statuses: DELIVERY_STATUSES
    ADD CONSTRAINT "OpsObserverDelivery_status_check"
        CHECK ("status" IN ('reserved', 'confirmed', 'shadowed', 'abandoned')),
    -- modes: GENESIS_MODES
    ADD CONSTRAINT "OpsObserverDelivery_mode_check"
        CHECK ("mode" IN ('shadow', 'live')),
    ADD CONSTRAINT "OpsObserverDelivery_runId_check"
        CHECK ("runId" ~ '^[0-9a-z][0-9a-z:_-]{0,127}$'),
    ADD CONSTRAINT "OpsObserverDelivery_lifecycle_check"
        CHECK (
          ("status" = 'reserved'  AND "reservedMarker" = 1
             AND "confirmedAt" IS NULL AND "shadowedAt" IS NULL AND "abandonedAt" IS NULL)
          OR ("status" = 'confirmed' AND "reservedMarker" IS NULL AND "mode" = 'live'
             AND "confirmedAt" IS NOT NULL AND "shadowedAt" IS NULL AND "abandonedAt" IS NULL)
          OR ("status" = 'shadowed'  AND "reservedMarker" IS NULL AND "mode" = 'shadow'
             AND "confirmedAt" IS NULL AND "shadowedAt" IS NOT NULL AND "abandonedAt" IS NULL)
          OR ("status" = 'abandoned' AND "reservedMarker" IS NULL
             AND "confirmedAt" IS NULL AND "shadowedAt" IS NULL AND "abandonedAt" IS NOT NULL)
        ),
    ADD CONSTRAINT "OpsObserverDelivery_stampStatus_check" CHECK ("stampStatus" = "status");

CREATE INDEX "OpsObserverDelivery_genesisId_ownerDate_idx" ON "OpsObserverDelivery"("genesisId", "ownerDate");

CREATE TABLE "OpsObserverDeliveryItem" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "capped" BOOLEAN NOT NULL,

    CONSTRAINT "OpsObserverDeliveryItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OpsObserverDeliveryItem"
    ADD CONSTRAINT "OpsObserverDeliveryItem_deliveryId_fkey" FOREIGN KEY ("deliveryId")
        REFERENCES "OpsObserverDelivery"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
    ADD CONSTRAINT "OpsObserverDeliveryItem_incident_kind_key"
        UNIQUE ("mode", "signal", "scope", "kind", "openedAt"),
    -- modes: GENESIS_MODES
    ADD CONSTRAINT "OpsObserverDeliveryItem_mode_check"
        CHECK ("mode" IN ('shadow', 'live')),
    -- kinds: MESSAGE_KINDS
    ADD CONSTRAINT "OpsObserverDeliveryItem_kind_check"
        CHECK ("kind" IN ('new_open', 'worsening', 'reopen', 'recovery')),
    -- origins: ITEM_ORIGINS
    ADD CONSTRAINT "OpsObserverDeliveryItem_origin_check"
        CHECK ("origin" IN ('new', 'reopen')),
    ADD CONSTRAINT "OpsObserverDeliveryItem_signal_check"
        CHECK ("signal" ~ '^[A-Za-z][A-Za-z0-9-]{0,7}$'),
    ADD CONSTRAINT "OpsObserverDeliveryItem_scope_check"
        CHECK ("scope" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$');

CREATE INDEX "OpsObserverDeliveryItem_deliveryId_idx" ON "OpsObserverDeliveryItem"("deliveryId");

CREATE FUNCTION ops_observer_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  genesis_mode text;
  superseded   boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'reserved'
       OR coalesce(OLD."confirmedAt", OLD."shadowedAt", OLD."abandonedAt")
          > clock_timestamp() - interval '90 days' THEN
      RAISE EXCEPTION 'ops_observer_delivery_not_deletable' USING ERRCODE = 'OB050';
    END IF;
    RETURN OLD;
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ops_observer_isolation_not_read_committed' USING ERRCODE = 'OB040';
  END IF;
  EXECUTE format('SELECT %I.ops_observer_deadline_claim($1)', TG_TABLE_SCHEMA) USING NEW."runDeadlineAt";

  IF TG_OP = 'INSERT' THEN
    -- Lock, then look, as the state guard does.
    EXECUTE format('SELECT mode FROM %I."OpsObserverGenesis" WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA)
      INTO genesis_mode USING NEW."genesisId";
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."OpsObserverGenesis" WHERE "supersedesGenesisId" = $1)',
                   TG_TABLE_SCHEMA)
      INTO superseded USING NEW."genesisId";
    IF superseded THEN
      RAISE EXCEPTION 'ops_observer_delivery_superseded' USING ERRCODE = 'OB051';
    END IF;
    IF NEW."status" <> 'reserved' THEN
      RAISE EXCEPTION 'ops_observer_delivery_not_reserved' USING ERRCODE = 'OB052';
    END IF;
    NEW."mode"             := genesis_mode;
    NEW."reservedMarker"   := 1;
    NEW."reservedAt"       := clock_timestamp();
    NEW."confirmedAt"      := NULL;
    NEW."shadowedAt"       := NULL;
    NEW."abandonedAt"      := NULL;
    NEW."invariantVersion" := 1;
    NEW."stampStatus"      := NEW."status";
    RETURN NEW;
  END IF;

  -- UPDATE: only the close, and only once.
  IF OLD."status" <> 'reserved' THEN
    RAISE EXCEPTION 'ops_observer_delivery_closed' USING ERRCODE = 'OB053';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."genesisId" <> OLD."genesisId" OR NEW."mode" <> OLD."mode"
     OR NEW."runId" <> OLD."runId" OR NEW."ownerDate" <> OLD."ownerDate"
     OR NEW."channelCheckDate" IS DISTINCT FROM OLD."channelCheckDate"
     OR NEW."digestItemId" IS DISTINCT FROM OLD."digestItemId"
     OR NEW."reservedAt" <> OLD."reservedAt" THEN
    RAISE EXCEPTION 'ops_observer_delivery_immutable' USING ERRCODE = 'OB054';
  END IF;
  IF NEW."status" = 'confirmed' AND OLD."mode" <> 'live'
     OR NEW."status" = 'shadowed' AND OLD."mode" <> 'shadow'
     OR NEW."status" NOT IN ('confirmed', 'shadowed', 'abandoned') THEN
    RAISE EXCEPTION 'ops_observer_delivery_transition' USING ERRCODE = 'OB055';
  END IF;
  NEW."reservedMarker"   := NULL;
  NEW."confirmedAt"      := CASE WHEN NEW."status" = 'confirmed' THEN clock_timestamp() END;
  NEW."shadowedAt"       := CASE WHEN NEW."status" = 'shadowed'  THEN clock_timestamp() END;
  NEW."abandonedAt"      := CASE WHEN NEW."status" = 'abandoned' THEN clock_timestamp() END;
  NEW."invariantVersion" := 1;
  NEW."stampStatus"      := NEW."status";
  RETURN NEW;
END $$;

CREATE TRIGGER "OpsObserverDelivery_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverDelivery"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_delivery_guard();

CREATE CONSTRAINT TRIGGER ops_observer_delivery_deadline_check
    AFTER INSERT OR UPDATE ON "OpsObserverDelivery"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ops_observer_deadline_check();

CREATE FUNCTION ops_observer_delivery_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parent_status   text;
  parent_mode     text;
  parent_own      boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only as part of deleting the reservation (the foreign key's cascade runs
    -- one trigger level below this one).
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'ops_observer_delivery_item_not_deletable' USING ERRCODE = 'OB060';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ops_observer_delivery_item_immutable' USING ERRCODE = 'OB061';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ops_observer_isolation_not_read_committed' USING ERRCODE = 'OB040';
  END IF;
  -- The reservation row was written by this very transaction exactly when its
  -- xmin is this transaction's id: a reserved row is never updated before it
  -- closes, so its xmin is still the inserting transaction's. A timestamp
  -- comparison could not tell two transactions that began in the same
  -- millisecond apart; this can. (Inside a savepoint the row's xmin is the
  -- subtransaction's and the item is refused, which is the safe answer.)
  EXECUTE format('SELECT status, mode, xmin = pg_current_xact_id()::xid FROM %I."OpsObserverDelivery" WHERE id = $1 FOR SHARE',
                 TG_TABLE_SCHEMA)
    INTO parent_status, parent_mode, parent_own USING NEW."deliveryId";
  IF parent_status IS DISTINCT FROM 'reserved' OR parent_own IS NOT TRUE THEN
    RAISE EXCEPTION 'ops_observer_delivery_item_not_same_transaction' USING ERRCODE = 'OB062';
  END IF;
  NEW."mode" := parent_mode;
  RETURN NEW;
END $$;

CREATE TRIGGER "OpsObserverDeliveryItem_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "OpsObserverDeliveryItem"
    FOR EACH ROW EXECUTE FUNCTION ops_observer_delivery_item_guard();

COMMIT;
