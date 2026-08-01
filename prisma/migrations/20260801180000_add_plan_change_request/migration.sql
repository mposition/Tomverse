-- A Pro <-> Max plan change: the quote we showed, and the reservation it became.
CREATE TABLE "PlanChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "execution" TEXT NOT NULL,
    "fromTier" TEXT NOT NULL,
    "toTier" TEXT NOT NULL,
    "billingInterval" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeSubscriptionItemId" TEXT NOT NULL,
    "targetStripePriceId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "renewalDecision" TEXT NOT NULL,
    "quotedAmountMinor" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'previewed',
    "appliesAt" TIMESTAMP(3),
    "stripeScheduleId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanChangeRequest_userId_status_idx" ON "PlanChangeRequest"("userId", "status");
CREATE INDEX "PlanChangeRequest_stripeSubscriptionId_status_idx" ON "PlanChangeRequest"("stripeSubscriptionId", "status");
CREATE INDEX "PlanChangeRequest_status_createdAt_idx" ON "PlanChangeRequest"("status", "createdAt");

ALTER TABLE "PlanChangeRequest" ADD CONSTRAINT "PlanChangeRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One in-flight change per account. A second confirm cannot create a competing
-- reservation, whatever the application layer does.
CREATE UNIQUE INDEX "PlanChangeRequest_userId_active_key"
    ON "PlanChangeRequest"("userId")
    WHERE "status" = 'pending';
