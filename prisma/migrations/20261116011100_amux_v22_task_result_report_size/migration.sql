-- Owner decision 2026-11-15: a v22 run's report crosses the bridge and is
-- stored up to the local CLI flow's transport backstop (32 MiB,
-- AMUX_V22_TRANSPORT_MAX_BYTES in lib/amux/v22LocalCliFlowCore.ts), which the
-- result route and lib/amux/v22TaskResultStore.ts already accept; this CHECK
-- still refused anything over the earlier flow's 64 KiB. Only the byteLength
-- bound changes; the rest of the CHECK is as it was. Rollback: drop and add
-- the constraint again with 65536 (no row over it exists before this change).
ALTER TABLE "AmuxV22TaskResult"
  DROP CONSTRAINT "AmuxV22TaskResult_digest_check",
  ADD CONSTRAINT "AmuxV22TaskResult_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "sourceSha256" ~ '^[0-9a-f]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "byteLength" BETWEEN 1 AND 33554432
  );
