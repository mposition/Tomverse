-- baseline-check: present-if-relation "AmuxCardWaitReason"
-- Owner decision 2026-11-15: why a card is not running, and what the AMUX box
-- says about each worker's sign-in, are kept as data Admin reads, not only as
-- one aggregate log line per claim tick or a box journal line.
--
-- AmuxCardWaitReason: one row per card the automatic promotion or the claim
-- passed over, with the reason code and its structured detail (codes and card
-- keys only, never worker text), when the same reason began, when it was last
-- seen and when a long wait was raised as an operational incident. Replaced on
-- every pass and removed when the card is claimed (lib/amux/cardWaitReasonStore.ts).
--
-- AmuxWorkerHealthSignal: the latest signal per worker and source that the
-- worker's box bridge forwarded: the Claude login keepalive, the sign-in
-- stage, the sidecar (lib/amux/workerHealthSignalStore.ts). Non-secret facts
-- only: a state code, an observation time and an expiry time at most.
--
-- Additive: two new tables, no existing row changes.
BEGIN;

CREATE TABLE "AmuxCardWaitReason" (
  "taskId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "detail" JSONB NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "seenCount" INTEGER NOT NULL DEFAULT 1,
  "reportedAt" TIMESTAMP(3),
  CONSTRAINT "AmuxCardWaitReason_pkey" PRIMARY KEY ("taskId"),
  CONSTRAINT "AmuxCardWaitReason_shape_check" CHECK (
    "lastSeenAt" >= "firstSeenAt" AND
    "seenCount" >= 1 AND
    "stage" IN ('promotion', 'claim') AND
    "code" ~ '^[a-z0-9_]{1,64}$' AND
    jsonb_typeof("detail") = 'object' AND
    octet_length("detail"::text) <= 8192
  )
);

CREATE INDEX "AmuxCardWaitReason_lastSeenAt_idx" ON "AmuxCardWaitReason"("lastSeenAt");

ALTER TABLE "AmuxCardWaitReason"
  ADD CONSTRAINT "AmuxCardWaitReason_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AmuxWorkerHealthSignal" (
  "workerName" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "signal" TEXT NOT NULL,
  "detail" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "reportedAt" TIMESTAMP(3),
  CONSTRAINT "AmuxWorkerHealthSignal_pkey" PRIMARY KEY ("workerName", "source"),
  CONSTRAINT "AmuxWorkerHealthSignal_shape_check" CHECK (
    "workerName" ~ '^[A-Za-z0-9._:-]{1,120}$' AND
    "source" IN ('login_keepalive', 'auth_stage', 'sidecar') AND
    "signal" ~ '^[a-z0-9_]{1,64}$' AND
    jsonb_typeof("detail") = 'object' AND
    octet_length("detail"::text) <= 2048 AND
    "receivedAt" >= "firstSeenAt"
  )
);

COMMIT;
