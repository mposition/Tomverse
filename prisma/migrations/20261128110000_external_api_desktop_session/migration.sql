-- Desktop Code runs on the signed-in Desktop session instead of an API key
-- (owner decision 2026-11-27, docs/policy/external-api.md section 11.2),
-- behind TOMVERSE_DESKTOP_CODE_SESSION_ENABLED (off). A request Desktop Code
-- sends that way has no key, so its receipt names the account instead.
--
--   keyId          becomes nullable: NULL exactly for a Desktop session
--                  request. Every row written so far has a key and keeps it.
--   desktopUserId  new, nullable: the account id, set exactly for a Desktop
--                  session request. It scopes that request's Idempotency-Key
--                  and its receipts as keyId scopes a key request's, and its
--                  foreign key removes the row with the account (a key
--                  request is removed with its key, which goes with the
--                  account).
--
-- No backfill: existing rows are key requests, keyId set and desktopUserId
-- NULL, which is exactly what the two checks below require. A plain unique
-- index on (desktopUserId, idempotencyKeyDigest) rather than a partial one,
-- so `prisma db push` builds the same guarantee; PostgreSQL does not compare
-- NULLs, so key requests never meet it. Content-free, like the rest of the row.
--
-- Rollback (only while no Desktop session request exists):
--   ALTER TABLE "ExternalApiRequest" DROP COLUMN "desktopUserId";
--   ALTER TABLE "ExternalApiRequest" ALTER COLUMN "keyId" SET NOT NULL;
ALTER TABLE "ExternalApiRequest" ALTER COLUMN "keyId" DROP NOT NULL;
ALTER TABLE "ExternalApiRequest" ADD COLUMN "desktopUserId" TEXT;

CREATE UNIQUE INDEX "ExternalApiRequest_desktopUserId_idempotencyKeyDigest_key" ON "ExternalApiRequest"("desktopUserId", "idempotencyKeyDigest");
CREATE INDEX "ExternalApiRequest_desktopUserId_createdAt_idx" ON "ExternalApiRequest"("desktopUserId", "createdAt");

ALTER TABLE "ExternalApiRequest" ADD CONSTRAINT "ExternalApiRequest_desktopUserId_fkey" FOREIGN KEY ("desktopUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one credential: a key, or the Desktop session of the row's own account.
ALTER TABLE "ExternalApiRequest"
    ADD CONSTRAINT "ExternalApiRequest_credential_check" CHECK (("keyId" IS NULL) <> ("desktopUserId" IS NULL)),
    ADD CONSTRAINT "ExternalApiRequest_desktopUserId_check" CHECK ("desktopUserId" IS NULL OR "desktopUserId" = "userId");
