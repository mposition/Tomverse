CREATE TABLE "ChatUsageBucket" (
    "key" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatUsageBucket_pkey" PRIMARY KEY ("key", "period", "periodStart")
);

CREATE TABLE "ChatRequestLease" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRequestLease_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatUsageBucket_updatedAt_idx" ON "ChatUsageBucket"("updatedAt");
CREATE INDEX "ChatRequestLease_subjectKey_expiresAt_idx"
    ON "ChatRequestLease"("subjectKey", "expiresAt");
