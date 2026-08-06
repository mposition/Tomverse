-- One row per account-data-export download request. The single-use ticket and
-- the audit record are the same row: a ticket table with no audit answers only
-- "can this link still be used", and an audit table written by a second call is
-- a call a future edit can forget.
--
-- The token is never stored, only its HMAC, so a copy of this table does not
-- yield a working download link.
CREATE TABLE "AccountDataExportRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "issuedIpHash" TEXT NOT NULL,
    "issuedUserAgentHash" TEXT NOT NULL,
    "consumedIpHash" TEXT,
    "consumedUserAgentHash" TEXT,
    "refusalReason" TEXT,
    "exportSchemaVersion" INTEGER,
    "includedDomainCount" INTEGER,
    "filteredDomainCount" INTEGER,
    "byteLength" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDataExportRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountDataExportRequest_tokenHash_key"
    ON "AccountDataExportRequest"("tokenHash");

CREATE INDEX "AccountDataExportRequest_userId_createdAt_idx"
    ON "AccountDataExportRequest"("userId", "createdAt");

-- Drives the retention sweep.
CREATE INDEX "AccountDataExportRequest_expiresAt_idx"
    ON "AccountDataExportRequest"("expiresAt");

CREATE INDEX "AccountDataExportRequest_status_createdAt_idx"
    ON "AccountDataExportRequest"("status", "createdAt");

-- The audit trail belongs to the account and goes with it. Cascade rather than
-- an explicit delete, so the data-domain registry can verify the claim against
-- the schema instead of trusting that a line in accountDeletion.ts still exists.
ALTER TABLE "AccountDataExportRequest"
    ADD CONSTRAINT "AccountDataExportRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the four recorded refusals, so an unrecognised value fails at write time
-- rather than becoming an unexplained audit row.
ALTER TABLE "AccountDataExportRequest"
    ADD CONSTRAINT "AccountDataExportRequest_status_check"
    CHECK ("status" IN ('issued', 'downloaded', 'refused'));

ALTER TABLE "AccountDataExportRequest"
    ADD CONSTRAINT "AccountDataExportRequest_refusalReason_check"
    CHECK (
        "refusalReason" IS NULL
        OR "refusalReason" IN ('unknown_token', 'wrong_user', 'expired', 'already_used')
    );
