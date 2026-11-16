-- Owner decision 2026-11-16: an owner's recovery approval may name a next
-- attempt number with no bound of ours (it was 64,
-- 20261116011700_amux_v22_recovery_approval_attempt_bound); it only has to be
-- positive, as the attempt guards now require
-- (20261116130200, 20261116130300). Every other term of the shape check is
-- unchanged. Existing rows all satisfy it.
ALTER TABLE "AmuxV22TaskRecoveryApproval"
  DROP CONSTRAINT "AmuxV22RecoveryApproval_shape_check",
  ADD CONSTRAINT "AmuxV22RecoveryApproval_shape_check" CHECK (((("beforeRevision" >= 0) AND ("beforeRevision" <= 2147483644)) AND ("afterRevision" = ("beforeRevision" + 1)) AND ("historicalAttempts" > 0) AND ("nextAttemptNumber" > "historicalAttempts") AND ("nextAttemptNumber" >= 1) AND ("oldHeldMicroUsd" > 0) AND ("additionalCapMicroUsd" > 0) AND ("worstExposureMicroUsd" = ("oldHeldMicroUsd" + "additionalCapMicroUsd")) AND ("evidenceDigest" ~ '^[a-f0-9]{64}$'::text) AND ("costDigest" ~ '^[a-f0-9]{64}$'::text) AND ("costReceiptDigest" ~ '^[a-f0-9]{64}$'::text) AND (jsonb_typeof("costReceipt") = 'object'::text)));
