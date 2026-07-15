-- CreateTable
CREATE TABLE "ComparisonReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "promptMessageId" TEXT NOT NULL,
    "assistantMessageIds" JSONB NOT NULL,
    "reviewerModelId" TEXT NOT NULL,
    "reviewMode" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "usageCredits" INTEGER NOT NULL,
    "inputHash" TEXT NOT NULL,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComparisonReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComparisonReview_userId_inputHash_key"
ON "ComparisonReview"("userId", "inputHash");

CREATE INDEX "ComparisonReview_conversationId_createdAt_idx"
ON "ComparisonReview"("conversationId", "createdAt");

CREATE INDEX "ComparisonReview_conversationId_isStale_idx"
ON "ComparisonReview"("conversationId", "isStale");

ALTER TABLE "ComparisonReview"
ADD CONSTRAINT "ComparisonReview_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComparisonReview"
ADD CONSTRAINT "ComparisonReview_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
