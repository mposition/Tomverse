-- Guest concurrency is scoped to the signed guest cookie, not to the IP.
--
-- Two additions make that possible without losing the anonymous abuse ceiling
-- the IP scope was actually providing:
--
--   * `ipKey` lets one lease row be counted in two scopes -- the caller's own
--     limit and the far higher per-IP ceiling -- so a request still has exactly
--     one thing to release.
--   * `admissionId` / `modelId` / `claimedAt` let the aggregate comparison
--     preflight reserve every slot a multi-model run needs in one transaction
--     and hand the individual model requests a slot to claim, instead of each
--     request racing for its own.
--
-- `heartbeatAt` records the last renewal from a running stream, so a long but
-- healthy response no longer outlives its own lease.
--
-- Existing rows are in-flight requests from the previous deployment. They keep
-- their (IP-scoped for guests) subjectKey and expire on their own within one
-- old TTL; backfilling them into a different scope would double-count.
ALTER TABLE "ChatRequestLease"
  ADD COLUMN IF NOT EXISTS "ipKey" TEXT,
  ADD COLUMN IF NOT EXISTS "admissionId" TEXT,
  ADD COLUMN IF NOT EXISTS "modelId" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "ChatRequestLease_ipKey_expiresAt_idx"
  ON "ChatRequestLease" ("ipKey", "expiresAt");

CREATE INDEX IF NOT EXISTS "ChatRequestLease_admissionId_idx"
  ON "ChatRequestLease" ("admissionId");

-- Supports the orphan sweep, which scans by expiry across every subject.
CREATE INDEX IF NOT EXISTS "ChatRequestLease_expiresAt_idx"
  ON "ChatRequestLease" ("expiresAt");
