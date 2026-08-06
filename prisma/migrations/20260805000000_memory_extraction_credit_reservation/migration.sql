-- The credit reservation for one extraction run (policy §11).
--
-- One row per run, not per chunk. §11 shows the chunk plan and its credit
-- total before the run starts and refuses a stale confirmation, so the run is
-- the unit the user actually agreed to. Reserving per chunk would let a run
-- they agreed to pay N credits for stop halfway because their balance moved
-- underneath it -- a worse promise than the one they were shown.
--
-- Provider budget stays a per-chunk re-check. That is the operational
-- guardrail layer (AGENTS.md keeps it separate from entitlement on purpose);
-- this table is entitlement, reserved once from what the user holds.
--
-- Every identity column is a plain string rather than a foreign key: this
-- financial record must outlive the run, the catalogue entry for the model and
-- the conversations the run read. `userId` is the one relation, and it is
-- SET NULL rather than CASCADE for the same reason.
CREATE TABLE "MemoryExtractionCreditReservation" (
    "id"     TEXT NOT NULL,
    "userId" TEXT,
    "runId"  TEXT NOT NULL,

    "status"  TEXT NOT NULL DEFAULT 'reserved',
    "outcome" TEXT,

    "provider"          TEXT NOT NULL,
    "extractionModelId" TEXT NOT NULL,
    "promptVersion"     TEXT NOT NULL,

    "chunkTotal"    INTEGER NOT NULL,
    "chunksCharged" INTEGER NOT NULL DEFAULT 0,

    "reservedCredits"           INTEGER NOT NULL,
    "planReservedCredits"       INTEGER NOT NULL,
    "addOnReservedCredits"      INTEGER NOT NULL,
    "reservedCostMicroUsd"      BIGINT  NOT NULL,
    "settledCredits"            INTEGER NOT NULL DEFAULT 0,
    "settledCostMicroUsd"       BIGINT  NOT NULL DEFAULT 0,
    "settledFundedCostMicroUsd" BIGINT  NOT NULL DEFAULT 0,

    "pricingVersion"     TEXT NOT NULL,
    "costSource"         TEXT NOT NULL,
    "pricingSnapshot"    JSONB NOT NULL,
    "reservationPayload" JSONB NOT NULL,

    "refundedAt" TIMESTAMP(3),
    "settledAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryExtractionCreditReservation_pkey" PRIMARY KEY ("id")
);

-- One reservation per run. This is the idempotency key of the reserve step:
-- a retried run creation cannot open a second reservation against the same
-- run and charge the account twice.
CREATE UNIQUE INDEX "MemoryExtractionCreditReservation_runId_key"
    ON "MemoryExtractionCreditReservation" ("runId");

CREATE INDEX "MemoryExtractionCreditReservation_status_createdAt_idx"
    ON "MemoryExtractionCreditReservation" ("status", "createdAt");
CREATE INDEX "MemoryExtractionCreditReservation_userId_createdAt_idx"
    ON "MemoryExtractionCreditReservation" ("userId", "createdAt");

ALTER TABLE "MemoryExtractionCreditReservation"
    ADD CONSTRAINT "MemoryExtractionCreditReservation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- `settling` is not decoration. It is the state that makes settlement
-- idempotent: settling claims the row by moving it out of `reserved`, so a
-- second settle -- a retry, a duplicate maintenance sweep -- finds nothing to
-- claim and refunds nothing a second time.
ALTER TABLE "MemoryExtractionCreditReservation"
    ADD CONSTRAINT "MemoryExtractionCreditReservation_status_check"
    CHECK ("status" IN ('reserved', 'settling', 'settled'));

ALTER TABLE "MemoryExtractionCreditReservation"
    ADD CONSTRAINT "MemoryExtractionCreditReservation_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'failed', 'cancelled'));

-- An account is never charged for more chunks than the run planned, and never
-- for a negative number of them. Both directions are arithmetic the settlement
-- step performs, so both are checked where the arithmetic lands.
ALTER TABLE "MemoryExtractionCreditReservation"
    ADD CONSTRAINT "MemoryExtractionCreditReservation_chunks_charged_check"
    CHECK ("chunksCharged" >= 0 AND "chunksCharged" <= "chunkTotal");

-- Settled credits can never exceed what was reserved. A settlement that
-- charged more than the user confirmed would be a silent re-price of a run
-- they already agreed to.
ALTER TABLE "MemoryExtractionCreditReservation"
    ADD CONSTRAINT "MemoryExtractionCreditReservation_settled_credits_check"
    CHECK ("settledCredits" >= 0 AND "settledCredits" <= "reservedCredits");

-- The plan/add-on split has to add back up to the total it was split from.
ALTER TABLE "MemoryExtractionCreditReservation"
    ADD CONSTRAINT "MemoryExtractionCreditReservation_reserved_split_check"
    CHECK ("planReservedCredits" + "addOnReservedCredits" = "reservedCredits");
