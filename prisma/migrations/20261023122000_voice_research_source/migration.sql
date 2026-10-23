ALTER TABLE "PerplexityAsyncJob" ADD COLUMN "sourceUserMessageId" TEXT;
CREATE INDEX "PerplexityAsyncJob_conversationId_sourceUserMessageId_idx" ON "PerplexityAsyncJob"("conversationId", "sourceUserMessageId");
