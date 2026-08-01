CREATE TABLE "Feedback" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "message" TEXT NOT NULL,
  "traceId" TEXT,
  "modelId" TEXT,
  "plan" TEXT,
  "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
  "attachmentCount" INTEGER NOT NULL DEFAULT 0,
  "path" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");
CREATE INDEX "Feedback_type_createdAt_idx" ON "Feedback"("type", "createdAt");
CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");
