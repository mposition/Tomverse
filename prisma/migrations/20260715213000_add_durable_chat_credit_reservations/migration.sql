CREATE TABLE "ChatCreditReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "outcome" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "providerResponseId" TEXT,
    "providerRequestLinkedAt" TIMESTAMP(3),
    "reservationPayload" JSONB NOT NULL,
    "reservedCredits" INTEGER NOT NULL,
    "reservedCostMicroUsd" BIGINT NOT NULL,
    "planReservedCredits" INTEGER NOT NULL,
    "addOnReservedCredits" INTEGER NOT NULL,
    "settledCredits" INTEGER NOT NULL DEFAULT 0,
    "settledCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatCreditReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatCreditReservation_idempotencyKey_key"
ON "ChatCreditReservation"("idempotencyKey");
CREATE INDEX "ChatCreditReservation_status_expiresAt_idx"
ON "ChatCreditReservation"("status", "expiresAt");
CREATE INDEX "ChatCreditReservation_userId_createdAt_idx"
ON "ChatCreditReservation"("userId", "createdAt");
CREATE INDEX "ChatCreditReservation_traceId_idx"
ON "ChatCreditReservation"("traceId");
CREATE INDEX "ChatCreditReservation_providerRequestId_idx"
ON "ChatCreditReservation"("providerRequestId");
CREATE INDEX "ChatCreditReservation_providerResponseId_idx"
ON "ChatCreditReservation"("providerResponseId");

ALTER TABLE "ChatCreditReservation"
ADD CONSTRAINT "ChatCreditReservation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
