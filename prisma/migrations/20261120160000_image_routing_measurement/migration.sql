-- The image routing improvement agent (docs/policy/image-generation.md §13):
-- content-free records of Chat's image routing decisions and of what people
-- did with the images, for the image routing report and optimizer.

CREATE TABLE "ImageRoutingDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "source" TEXT NOT NULL,
    "routerModelId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "imageModelId" TEXT,
    "preset" TEXT,
    "edit" BOOLEAN NOT NULL DEFAULT false,
    "followUp" BOOLEAN NOT NULL DEFAULT false,
    "attachedPhoto" BOOLEAN NOT NULL DEFAULT false,
    "modelFallback" BOOLEAN NOT NULL DEFAULT false,
    "candidateCount" INTEGER NOT NULL,
    "latencyMs" INTEGER,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageRoutingDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImageRoutingDecision_source_check" CHECK ("source" IN ('auto_chat', 'composer')),
    CONSTRAINT "ImageRoutingDecision_outcome_check" CHECK ("outcome" IN ('image', 'chat', 'error'))
);
CREATE UNIQUE INDEX "ImageRoutingDecision_groupId_key" ON "ImageRoutingDecision"("groupId");
CREATE INDEX "ImageRoutingDecision_createdAt_idx" ON "ImageRoutingDecision"("createdAt");
CREATE INDEX "ImageRoutingDecision_userId_createdAt_idx" ON "ImageRoutingDecision"("userId", "createdAt");
ALTER TABLE "ImageRoutingDecision" ADD CONSTRAINT "ImageRoutingDecision_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageRoutingDecision" ADD CONSTRAINT "ImageRoutingDecision_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "ImageGenerationGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ImageGenerationSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageGenerationSignal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImageGenerationSignal_kind_check" CHECK ("kind" IN ('download', 'selected', 'helpful', 'not_helpful', 'wanted_text'))
);
CREATE UNIQUE INDEX "ImageGenerationSignal_userId_generationId_kind_key" ON "ImageGenerationSignal"("userId", "generationId", "kind");
CREATE INDEX "ImageGenerationSignal_createdAt_idx" ON "ImageGenerationSignal"("createdAt");
CREATE INDEX "ImageGenerationSignal_generationId_idx" ON "ImageGenerationSignal"("generationId");
ALTER TABLE "ImageGenerationSignal" ADD CONSTRAINT "ImageGenerationSignal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageGenerationSignal" ADD CONSTRAINT "ImageGenerationSignal_generationId_fkey"
    FOREIGN KEY ("generationId") REFERENCES "ImageGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A fourth guidance an optimizer cycle may improve: the Chat image routing
-- criteria (lib/imageRoutingOptimizer.ts), on the shared lock and caps.
ALTER TABLE "AutoRouterOptimizerCycle"
    DROP CONSTRAINT "AutoRouterOptimizerCycle_target_check",
    ADD CONSTRAINT "AutoRouterOptimizerCycle_target_check" CHECK ("target" IN ('routing', 'rewrite', 'coding', 'image'));
