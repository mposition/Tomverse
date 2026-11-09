-- Content-free operational timing samples; no account, conversation or text data.
CREATE TABLE "ResponseLatencySample" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "modelId" TEXT,
    "provider" TEXT,
    "outcome" TEXT NOT NULL,
    "timings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResponseLatencySample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResponseLatencySample_createdAt_idx" ON "ResponseLatencySample"("createdAt");
