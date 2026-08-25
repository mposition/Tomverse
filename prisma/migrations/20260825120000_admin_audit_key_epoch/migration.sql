-- Which signing key produced each audit entry's hash.
--
-- Contract: docs/ops/admin-audit-key-epochs.md.
--
-- Nullable with no default and no back-fill. NULL means "signed under the
-- pre-epoch key", which is true of every row that exists when this runs, and
-- verification resolves it that way. A default would claim those rows were
-- signed under an epoch that did not sign them.
ALTER TABLE "AdminAuditLog" ADD COLUMN "keyEpoch" TEXT;

-- Verification walks oldest-first and groups its report by epoch, so the epoch
-- is read for every row in the chain.
CREATE INDEX "AdminAuditLog_keyEpoch_idx" ON "AdminAuditLog" ("keyEpoch");
