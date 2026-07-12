CREATE TABLE "AdminNote" (
  "id" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdById" TEXT,
  "createdByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelOverride" (
  "modelId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "visibleNote" TEXT,
  "updatedById" TEXT,
  "updatedByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModelOverride_pkey" PRIMARY KEY ("modelId")
);

CREATE TABLE "AdminNotificationLog" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminNotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminNote_targetType_targetId_createdAt_idx" ON "AdminNote"("targetType", "targetId", "createdAt");
CREATE INDEX "AdminNote_createdById_createdAt_idx" ON "AdminNote"("createdById", "createdAt");
CREATE INDEX "ModelOverride_status_idx" ON "ModelOverride"("status");
CREATE INDEX "AdminNotificationLog_channel_createdAt_idx" ON "AdminNotificationLog"("channel", "createdAt");
CREATE INDEX "AdminNotificationLog_status_createdAt_idx" ON "AdminNotificationLog"("status", "createdAt");
CREATE INDEX "AdminNotificationLog_targetType_targetId_idx" ON "AdminNotificationLog"("targetType", "targetId");

ALTER TABLE "AdminNote" ADD CONSTRAINT "AdminNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModelOverride" ADD CONSTRAINT "ModelOverride_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
