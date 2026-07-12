CREATE TABLE "RefundRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT,
  "plan" TEXT,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "subscriptionStatus" TEXT,
  "subscriptionCurrentPeriodEnd" TIMESTAMP(3),
  "subscriptionBillingInterval" TEXT,
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "adminNote" TEXT,
  "reviewedByUserId" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RefundRequest"
  ADD CONSTRAINT "RefundRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "RefundRequest_status_requestedAt_idx" ON "RefundRequest"("status", "requestedAt");
CREATE INDEX "RefundRequest_userId_requestedAt_idx" ON "RefundRequest"("userId", "requestedAt");
CREATE INDEX "RefundRequest_email_idx" ON "RefundRequest"("email");
