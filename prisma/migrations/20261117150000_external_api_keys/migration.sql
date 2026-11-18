-- External inference API keys (docs/policy/external-api.md). Additive only:
-- two new tables, no existing row or column changes.
--
-- ExternalApiKey holds a SHA-256 digest of the secret, never the secret.
-- ExternalApiRequest links a key to the shared ChatCreditReservation that
-- holds and settles the request's credits; it stores no amounts of its own.
--
-- Rollback: DROP TABLE "ExternalApiRequest"; DROP TABLE "ExternalApiKey";
-- (no other table references them).
BEGIN;

-- CreateTable
CREATE TABLE "ExternalApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "creditCap" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalApiRequest" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "idempotencyKeyDigest" TEXT,
    "requestDigest" TEXT NOT NULL,
    "clientName" TEXT,
    "modelId" TEXT NOT NULL,
    "stream" BOOLEAN NOT NULL,
    "finishReason" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalApiRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApiKey_keyPrefix_key" ON "ExternalApiKey"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApiKey_secretDigest_key" ON "ExternalApiKey"("secretDigest");

-- CreateIndex
CREATE INDEX "ExternalApiKey_userId_createdAt_idx" ON "ExternalApiKey"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApiRequest_reservationId_key" ON "ExternalApiRequest"("reservationId");

-- CreateIndex
CREATE INDEX "ExternalApiRequest_userId_createdAt_idx" ON "ExternalApiRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalApiRequest_keyId_createdAt_idx" ON "ExternalApiRequest"("keyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApiRequest_keyId_idempotencyKeyDigest_key" ON "ExternalApiRequest"("keyId", "idempotencyKeyDigest");

-- AddForeignKey
ALTER TABLE "ExternalApiKey" ADD CONSTRAINT "ExternalApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApiRequest" ADD CONSTRAINT "ExternalApiRequest_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ExternalApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApiRequest" ADD CONSTRAINT "ExternalApiRequest_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "ChatCreditReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Format guards: a digest is lowercase hex, a name is short, a cap is positive.
ALTER TABLE "ExternalApiKey"
    ADD CONSTRAINT "ExternalApiKey_secretDigest_check" CHECK ("secretDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "ExternalApiKey_keyPrefix_check" CHECK ("keyPrefix" ~ '^tvk_[0-9a-z]{8}$'),
    ADD CONSTRAINT "ExternalApiKey_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    ADD CONSTRAINT "ExternalApiKey_creditCap_check" CHECK ("creditCap" IS NULL OR "creditCap" > 0);

ALTER TABLE "ExternalApiRequest"
    ADD CONSTRAINT "ExternalApiRequest_requestDigest_check" CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "ExternalApiRequest_idempotencyKeyDigest_check" CHECK ("idempotencyKeyDigest" IS NULL OR "idempotencyKeyDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "ExternalApiRequest_clientName_check" CHECK ("clientName" IS NULL OR char_length("clientName") <= 80);

COMMIT;
