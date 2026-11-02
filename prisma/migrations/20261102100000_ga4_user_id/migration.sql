-- The GA4 User-ID, stored (operator decision 2026-11-02;
-- docs/policy/marketing-automation.md §10.2). It replaces the HMAC of the
-- account id, which could not be unlinked from the account short of rotating
-- a key for everyone: a stored random value can be deleted for one account,
-- and that deletion is what withdrawing analytics consent does.
--
-- At most one row per account (the primary key is the account id). Created on
-- the first request after the visitor explicitly accepted analytics; deleted
-- on withdrawal, after one GA4 deletion request naming the value, and with the
-- account through the cascade, after the deletion transaction has read it so
-- the follow-up request can name it (lib/accountDeletion.ts).
--
-- No row has ever existed under the HMAC scheme and none is backfilled: the
-- privacy-notice constant that gates every id (lib/ga4UserIdPolicy.ts) has
-- never been true, so no derived id was handed out or sent.

-- CreateTable
CREATE TABLE "Ga4UserId" (
    "userId" TEXT NOT NULL,
    "analyticsUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ga4UserId_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ga4UserId_analyticsUserId_key" ON "Ga4UserId"("analyticsUserId");

-- AddForeignKey
ALTER TABLE "Ga4UserId" ADD CONSTRAINT "Ga4UserId_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only what `newAnalyticsUserId` produces (128 bits, lowercase hex) can be
-- stored, so no code path can put an account id or an email here and have it
-- sent to GA4 as a User-ID.
ALTER TABLE "Ga4UserId" ADD CONSTRAINT "Ga4UserId_analyticsUserId_check"
    CHECK ("analyticsUserId" ~ '^[0-9a-f]{32}$');
