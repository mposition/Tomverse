ALTER TABLE "User"
ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "accountSuspendedAt" TIMESTAMP(3),
ADD COLUMN "accountSuspendedUntil" TIMESTAMP(3),
ADD COLUMN "accountSuspensionReason" TEXT,
ADD COLUMN "accountSuspendedById" TEXT,
ADD COLUMN "accountSuspendedByEmail" TEXT,
ADD COLUMN "aiUsageRestricted" BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN "aiUsageRestrictedAt" TIMESTAMP(3),
ADD COLUMN "aiUsageRestrictedUntil" TIMESTAMP(3),
ADD COLUMN "aiUsageRestrictionReason" TEXT,
ADD COLUMN "aiUsageRestrictedById" TEXT,
ADD COLUMN "aiUsageRestrictedByEmail" TEXT,
ADD COLUMN "securityIncidentNote" TEXT,
ADD COLUMN "lastLoginAt" TIMESTAMP(3);

ALTER TABLE "Session"
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "User_accountStatus_accountSuspendedUntil_idx"
ON "User"("accountStatus", "accountSuspendedUntil");

CREATE INDEX "User_aiUsageRestricted_aiUsageRestrictedUntil_idx"
ON "User"("aiUsageRestricted", "aiUsageRestrictedUntil");

CREATE INDEX "Session_userId_createdAt_idx"
ON "Session"("userId", "createdAt");
