-- Owner direction 2026-11-15: an owner's recovery approval may name a next
-- attempt above five (infrastructure failures keep their number but do not
-- count; the app's runaway guard is thirty counted attempts). The bound is now
-- 64, as in the attempt guards (20261115140200, 20261115140300). Every other
-- part of the shape check is unchanged. Existing rows all satisfy it.
ALTER TABLE "AmuxV22TaskRecoveryApproval"
  DROP CONSTRAINT "AmuxV22RecoveryApproval_shape_check";

ALTER TABLE "AmuxV22TaskRecoveryApproval"
  ADD CONSTRAINT "AmuxV22RecoveryApproval_shape_check" CHECK (
    "beforeRevision" BETWEEN 0 AND 2147483644 AND "afterRevision" = "beforeRevision" + 1 AND
    "historicalAttempts" > 0 AND "nextAttemptNumber" > "historicalAttempts" AND
    "nextAttemptNumber" BETWEEN 1 AND 64 AND
    "oldHeldMicroUsd" > 0 AND "additionalCapMicroUsd" > 0 AND
    "worstExposureMicroUsd" = "oldHeldMicroUsd" + "additionalCapMicroUsd" AND
    "evidenceDigest" ~ '^[a-f0-9]{64}$' AND "costDigest" ~ '^[a-f0-9]{64}$' AND
    "costReceiptDigest" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("costReceipt") = 'object');
