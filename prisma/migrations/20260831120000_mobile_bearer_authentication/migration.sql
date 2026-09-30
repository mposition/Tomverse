-- Native mobile bearer authentication (N2).
--
-- The five tables of the approved design,
-- .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md section 6.
--
-- Nothing here is reachable yet: N1B_BEARER_ROUTES ships empty, so a native
-- mutation still meets the mutation-origin check and is refused. These tables
-- exist so the issue, rotate and revoke services have somewhere to write.
--
-- Three properties are enforced by the database rather than by the code that
-- writes it:
--
--   * the refresh token itself is absent. A rotation row holds an HMAC of the
--     secret under a rotating pepper, and its `id` -- the front half of the
--     presented token -- is not a secret, which is why the unique index is on
--     the digest and not on anything an attacker could name;
--   * every table reaches User by ON DELETE CASCADE, so account deletion takes
--     the devices, the families, the rotations under them, the outstanding
--     login grants and the audit events with it;
--   * an audit event that names a device or a family must also name the
--     account (MobileAuthEvent_subject_identifier_check). Without that, a row
--     identifying somebody's device could survive the cascade that is supposed
--     to remove every row identifying them.

-- CreateTable
CREATE TABLE "MobileDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "MobileDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileTokenFamily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "epoch" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MobileTokenFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileRefreshRotation" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "pepperKid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "supersededById" TEXT,

    CONSTRAINT "MobileRefreshRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileLoginGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "clientBindingDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileLoginGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileAuthEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "familyId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "MobileAuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileDevice_userId_lastSeenAt_idx" ON "MobileDevice"("userId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "MobileDevice_userId_revokedAt_idx" ON "MobileDevice"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "MobileTokenFamily_userId_revokedAt_idx" ON "MobileTokenFamily"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "MobileTokenFamily_deviceId_revokedAt_idx" ON "MobileTokenFamily"("deviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "MobileTokenFamily_absoluteExpiresAt_idx" ON "MobileTokenFamily"("absoluteExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileRefreshRotation_secretDigest_key" ON "MobileRefreshRotation"("secretDigest");

-- CreateIndex
CREATE INDEX "MobileRefreshRotation_familyId_consumedAt_invalidatedAt_exp_idx" ON "MobileRefreshRotation"("familyId", "consumedAt", "invalidatedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "MobileRefreshRotation_expiresAt_idx" ON "MobileRefreshRotation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileLoginGrant_secretDigest_key" ON "MobileLoginGrant"("secretDigest");

-- CreateIndex
CREATE INDEX "MobileLoginGrant_userId_idx" ON "MobileLoginGrant"("userId");

-- CreateIndex
CREATE INDEX "MobileLoginGrant_expiresAt_idx" ON "MobileLoginGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "MobileAuthEvent_userId_occurredAt_idx" ON "MobileAuthEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "MobileAuthEvent_event_occurredAt_idx" ON "MobileAuthEvent"("event", "occurredAt");

-- CreateIndex
CREATE INDEX "MobileAuthEvent_occurredAt_idx" ON "MobileAuthEvent"("occurredAt");

-- AddForeignKey
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileTokenFamily" ADD CONSTRAINT "MobileTokenFamily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileTokenFamily" ADD CONSTRAINT "MobileTokenFamily_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MobileDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileRefreshRotation" ADD CONSTRAINT "MobileRefreshRotation_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "MobileTokenFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileLoginGrant" ADD CONSTRAINT "MobileLoginGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileAuthEvent" ADD CONSTRAINT "MobileAuthEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- --- closed lists, mirrored in lib/mobileAuthContract.ts --------------------
--
-- Registered in scripts/check-enum-constraints.mjs, which fails when one of
-- these and its application-side array stop agreeing.

ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_platform_check"
  CHECK ("platform" IN ('ios', 'android'));

ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_revokedReason_check"
  CHECK ("revokedReason" IS NULL OR "revokedReason" IN ('user_revoked'));

ALTER TABLE "MobileTokenFamily" ADD CONSTRAINT "MobileTokenFamily_revokedReason_check"
  CHECK (
    "revokedReason" IS NULL
    OR "revokedReason" IN ('logout', 'device_revoked', 'reuse_detected', 'account_deleted')
  );

ALTER TABLE "MobileAuthEvent" ADD CONSTRAINT "MobileAuthEvent_event_check"
  CHECK (
    "event" IN (
      'mobile_auth.exchanged',
      'mobile_auth.refreshed',
      'mobile_auth.refresh_rejected',
      'mobile_auth.reuse_detected',
      'mobile_auth.family_revoked',
      'mobile_auth.device_revoked',
      'mobile_auth.logged_out',
      'mobile_auth.revoked_on_account_deletion'
    )
  );

-- --- the cascade cannot be escaped by writing half an event ------------------
--
-- `deviceId` and `familyId` carry no foreign key: an audit row outlives the
-- device it describes on purpose, so that revoking a device does not erase the
-- record of revoking it. That is exactly why this constraint is here -- with no
-- foreign key of their own, those two columns are reached by nothing but
-- `userId`'s cascade, and a row that set them while leaving `userId` NULL would
-- be an identifier of a person that account deletion never touches.

ALTER TABLE "MobileAuthEvent" ADD CONSTRAINT "MobileAuthEvent_subject_identifier_check"
  CHECK (
    "userId" IS NOT NULL
    OR ("deviceId" IS NULL AND "familyId" IS NULL)
  );
