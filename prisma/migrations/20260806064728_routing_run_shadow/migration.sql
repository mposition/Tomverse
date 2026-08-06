-- CreateTable
CREATE TABLE "RoutingRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL DEFAULT 'shadow',
    "traceId" TEXT NOT NULL,
    "userId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "taskProfileVersion" TEXT NOT NULL,
    "candidateFilterVersion" TEXT NOT NULL,
    "selectionVersion" TEXT NOT NULL,
    "estimatorVersion" TEXT NOT NULL,
    "profileKind" TEXT NOT NULL,
    "profileConfidence" TEXT NOT NULL,
    "needsCurrentInformation" BOOLEAN NOT NULL,
    "hasImageInput" BOOLEAN NOT NULL,
    "hasDocumentInput" BOOLEAN NOT NULL,
    "expectedOutputLength" TEXT NOT NULL,
    "estimatedInputTokens" INTEGER NOT NULL,
    "reservedInputTokens" INTEGER NOT NULL,
    "requestOutputCapTokens" INTEGER NOT NULL,
    "eligibleCount" INTEGER NOT NULL,
    "rejectedByReason" JSONB NOT NULL,
    "selectedModelId" TEXT,
    "selectionReason" TEXT NOT NULL,
    "selectionMargin" INTEGER NOT NULL,
    "userSelectedModelId" TEXT NOT NULL,
    "decisionMicros" INTEGER NOT NULL,

    CONSTRAINT "RoutingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutingRun_createdAt_idx" ON "RoutingRun"("createdAt");

-- CreateIndex
CREATE INDEX "RoutingRun_mode_createdAt_idx" ON "RoutingRun"("mode", "createdAt");

-- CreateIndex
CREATE INDEX "RoutingRun_userId_createdAt_idx" ON "RoutingRun"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "RoutingRun" ADD CONSTRAINT "RoutingRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
