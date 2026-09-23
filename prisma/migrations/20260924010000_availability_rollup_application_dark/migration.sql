-- Which grain of an observation a projection has already applied.
--
-- AvailabilityObservation.eventId stops the same observation being inserted
-- twice. It does not record that the deployment rollup, the endpoint rollup,
-- and the provider rollup have each consumed it. This table is that record.
-- A second insert of the same triple is the replay trying to count twice.
-- Nothing in the runtime writes a row yet.
--
-- Rollback: drop the table after confirming no runtime source reads it.

CREATE TABLE "AvailabilityRollupApplication" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "grain" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityRollupApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AvailabilityRollupApplication_eventId_grain_targetId_key"
    ON "AvailabilityRollupApplication"("eventId", "grain", "targetId");

ALTER TABLE "AvailabilityRollupApplication"
    ADD CONSTRAINT "AvailabilityRollupApplication_grain_check"
    CHECK ("grain" IN ('deployment', 'endpoint', 'provider'));

ALTER TABLE "AvailabilityRollupApplication"
    ADD CONSTRAINT "AvailabilityRollupApplication_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "AvailabilityObservation"("eventId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
