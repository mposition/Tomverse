-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "pendingJobId" TEXT;

-- CreateTable
CREATE TABLE "PerplexityAsyncJob" (
    "id" TEXT NOT NULL,
    "perplexityJobId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "resultText" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPolledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerplexityAsyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PerplexityAsyncJob_perplexityJobId_key" ON "PerplexityAsyncJob"("perplexityJobId");

-- CreateIndex
CREATE UNIQUE INDEX "PerplexityAsyncJob_assistantMessageId_key" ON "PerplexityAsyncJob"("assistantMessageId");

-- CreateIndex
CREATE INDEX "PerplexityAsyncJob_status_lastPolledAt_idx" ON "PerplexityAsyncJob"("status", "lastPolledAt");
