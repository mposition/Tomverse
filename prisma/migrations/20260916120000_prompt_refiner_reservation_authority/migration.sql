-- Prompt Refiner reservation authority.
--
-- Deliberately no seed: deploying this migration authorizes no execution. A
-- separately approved future harness must create the one exact stage row.
-- Both tables are content-free and retain terminal rows as permanent slots.

CREATE TABLE "PromptRefinerReservationStage" (
    "id" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "contractDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "perRequestCostMicroUsd" BIGINT NOT NULL,
    "maxReservations" INTEGER NOT NULL,
    "costCeilingMicroUsd" BIGINT NOT NULL,
    "reservationCount" INTEGER NOT NULL DEFAULT 0,
    "allocatedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptRefinerReservationStage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerReservationStage_id_check"
        CHECK ("id" = 'prompt-refiner-shadow-v1'),
    CONSTRAINT "PromptRefinerReservationStage_status_check"
        CHECK ("status" IN ('approved', 'closed')),
    CONSTRAINT "PromptRefinerReservationStage_contract_check"
        CHECK (
            "contractVersion" = 'prompt-refiner-execution-contract-v1'
            AND "contractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
        ),
    CONSTRAINT "PromptRefinerReservationStage_constants_check"
        CHECK (
            "perRequestCostMicroUsd" = 24916
            AND "maxReservations" = 100
            AND "costCeilingMicroUsd" = 2491600
        ),
    CONSTRAINT "PromptRefinerReservationStage_counters_check"
        CHECK (
            "reservationCount" >= 0
            AND "reservationCount" <= "maxReservations"
            AND "allocatedCostMicroUsd" = "reservationCount"::BIGINT * "perRequestCostMicroUsd"
            AND "allocatedCostMicroUsd" <= "costCeilingMicroUsd"
        ),
    CONSTRAINT "PromptRefinerReservationStage_approvedBy_check"
        CHECK (length("approvedBy") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX "PromptRefinerReservationStage_contractDigest_key"
    ON "PromptRefinerReservationStage"("contractDigest");

CREATE TABLE "PromptRefinerReservation" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "contractDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reservedCostMicroUsd" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptRefinerReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerReservation_status_check"
        CHECK ("status" IN ('reserved', 'consumed', 'released', 'expired')),
    CONSTRAINT "PromptRefinerReservation_cost_check"
        CHECK ("reservedCostMicroUsd" = 24916),
    CONSTRAINT "PromptRefinerReservation_lifetime_check"
        CHECK ("expiresAt" = "createdAt" + INTERVAL '5 minutes'),
    CONSTRAINT "PromptRefinerReservation_terminal_check"
        CHECK (
            ("status" = 'reserved' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL)
            OR ("status" = 'consumed' AND "consumedAt" IS NOT NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL)
            OR ("status" = 'released' AND "consumedAt" IS NULL AND "releasedAt" IS NOT NULL AND "expiredAt" IS NULL)
            OR ("status" = 'expired' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "expiredAt" IS NOT NULL)
        ),
    CONSTRAINT "PromptRefinerReservation_requestId_check"
        CHECK (length("requestId") BETWEEN 1 AND 128 AND "requestId" ~ '^[A-Za-z0-9:_-]+$'),
    CONSTRAINT "PromptRefinerReservation_id_check"
        CHECK (length("id") BETWEEN 1 AND 128 AND "id" ~ '^[A-Za-z0-9:_-]+$')
);

CREATE UNIQUE INDEX "PromptRefinerReservation_requestId_key"
    ON "PromptRefinerReservation"("requestId");
CREATE INDEX "PromptRefinerReservation_stageId_status_expiresAt_idx"
    ON "PromptRefinerReservation"("stageId", "status", "expiresAt");

ALTER TABLE "PromptRefinerReservation"
    ADD CONSTRAINT "PromptRefinerReservation_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "PromptRefinerReservationStage"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A stage's bounds and approval provenance are immutable. A new stage always
-- starts at zero. Thereafter counters may only move to the exact aggregate of
-- already-visible reservation tombstones; a direct counter UPDATE therefore
-- has no value it can change to, while an AFTER INSERT trigger can bind a
-- successfully inserted row (or batch) to the counters.
CREATE FUNCTION "prompt_refiner_stage_guard"()
RETURNS TRIGGER AS $$
DECLARE
    actual_count INTEGER;
    actual_cost BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % cannot be deleted', OLD."id";
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."reservationCount" <> 0 OR NEW."allocatedCostMicroUsd" <> 0 THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage must start with zero accounting';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."contractVersion" IS DISTINCT FROM OLD."contractVersion"
       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
       OR NEW."maxReservations" IS DISTINCT FROM OLD."maxReservations"
       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % contract is immutable', OLD."id";
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (OLD."status" = 'approved' AND NEW."status" = 'closed') THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % status transition is invalid', OLD."id";
    END IF;
    IF NEW."reservationCount" = OLD."reservationCount"
       AND NEW."allocatedCostMicroUsd" = OLD."allocatedCostMicroUsd" THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
    INTO actual_count, actual_cost
    FROM "PromptRefinerReservation"
    WHERE "stageId" = OLD."id";
    IF NEW."reservationCount" <> actual_count
       OR NEW."allocatedCostMicroUsd" <> actual_cost THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % accounting must equal durable tombstones', OLD."id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_stage_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerReservationStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_stage_guard"();

-- The BEFORE trigger validates the candidate and serialises it on the fixed
-- stage, but deliberately does not account it before the row exists.
CREATE FUNCTION "prompt_refiner_reservation_insert_guard"()
RETURNS TRIGGER AS $$
DECLARE
    stage "PromptRefinerReservationStage"%ROWTYPE;
BEGIN
    IF NEW."status" <> 'reserved'
       OR NEW."consumedAt" IS NOT NULL
       OR NEW."releasedAt" IS NOT NULL
       OR NEW."expiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerReservation must start reserved';
    END IF;
    IF NEW."stageId" <> 'prompt-refiner-shadow-v1'
       OR NEW."contractDigest" <> 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
       OR NEW."reservedCostMicroUsd" <> 24916
       OR NEW."expiresAt" <> NEW."createdAt" + INTERVAL '5 minutes'
       OR NEW."createdAt" > (clock_timestamp() AT TIME ZONE 'UTC')
       OR NEW."expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
       OR NEW."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'PromptRefinerReservation contract binding is invalid';
    END IF;

    SELECT * INTO stage
    FROM "PromptRefinerReservationStage"
    WHERE "id" = 'prompt-refiner-shadow-v1'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
    END IF;
    IF stage."status" <> 'approved'
       OR stage."contractVersion" <> 'prompt-refiner-execution-contract-v1'
       OR stage."contractDigest" <> NEW."contractDigest"
       OR stage."perRequestCostMicroUsd" <> 24916
       OR stage."maxReservations" <> 100
       OR stage."costCeilingMicroUsd" <> 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage contract is not approved';
    END IF;
    IF stage."reservationCount" >= 100
       OR stage."allocatedCostMicroUsd" + 24916 > 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_reservation_insert_guard_trigger"
BEFORE INSERT ON "PromptRefinerReservation"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_reservation_insert_guard"();

-- Accounting happens only after PostgreSQL has made the successful INSERT
-- visible. A statement-level transition table also handles createMany as one
-- exact aggregate. Unique failures never reach this trigger, and any later
-- statement/transaction failure rolls both the row and accounting back.
CREATE FUNCTION "prompt_refiner_reservation_account_insert"()
RETURNS TRIGGER AS $$
DECLARE
    actual_count INTEGER;
    actual_cost BIGINT;
    changed INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM inserted_reservations) THEN
        RETURN NULL;
    END IF;
    SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
    INTO actual_count, actual_cost
    FROM "PromptRefinerReservation"
    WHERE "stageId" = 'prompt-refiner-shadow-v1';
    IF actual_count > 100 OR actual_cost > 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
    END IF;
    UPDATE "PromptRefinerReservationStage"
    SET "reservationCount" = actual_count,
        "allocatedCostMicroUsd" = actual_cost,
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id" = 'prompt-refiner-shadow-v1';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_reservation_account_insert_trigger"
AFTER INSERT ON "PromptRefinerReservation"
REFERENCING NEW TABLE AS inserted_reservations
FOR EACH STATEMENT EXECUTE FUNCTION "prompt_refiner_reservation_account_insert"();

-- Reservation identity and cost never change. A reserved row may transition
-- exactly once to a terminal tombstone and can never be deleted or recycled.
CREATE FUNCTION "prompt_refiner_reservation_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerReservation % cannot be deleted', OLD."id";
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
       OR NEW."reservedCostMicroUsd" IS DISTINCT FROM OLD."reservedCostMicroUsd"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservation % binding is immutable', OLD."id";
    END IF;
    IF OLD."status" <> 'reserved' THEN
        RAISE EXCEPTION 'PromptRefinerReservation % is already terminal', OLD."id";
    END IF;
    IF NEW."consumedAt" IS NOT NULL
       OR NEW."releasedAt" IS NOT NULL
       OR NEW."expiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerReservation % terminal timestamp is database-owned', OLD."id";
    END IF;
    IF NEW."status" NOT IN ('consumed', 'released', 'expired') THEN
        RAISE EXCEPTION 'PromptRefinerReservation % transition is invalid', OLD."id";
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC');
    IF NEW."status" = 'expired' AND observed_at < OLD."expiresAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservation % cannot expire before its deadline', OLD."id";
    END IF;
    IF observed_at >= OLD."expiresAt" THEN
        NEW."status" := 'expired';
        NEW."expiredAt" := observed_at;
    ELSIF NEW."status" = 'consumed' THEN
        NEW."consumedAt" := observed_at;
    ELSE
        NEW."releasedAt" := observed_at;
    END IF;
    NEW."updatedAt" := observed_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_reservation_guard_trigger"
BEFORE UPDATE OR DELETE ON "PromptRefinerReservation"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_reservation_guard"();
