-- Labelled data from Auto's per-prompt model choice (lib/autoLlmRouter.ts).
--
-- One row per turn where a model call chose the answering model: the exact
-- input it saw, the candidates, the deterministic rule's choice and the call's
-- pick. Kept so a Tomverse-trained triage can replace the call once there is
-- enough of it.
--
-- `routerInput` is the user's own message text, so the row is deleted with the
-- conversation and with the account (both FKs cascade).
--
-- baseline-check: present-if-relation "AutoRouterDecision"

-- CreateTable
CREATE TABLE "AutoRouterDecision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "routerInput" TEXT NOT NULL,
    "routerContext" TEXT,
    "candidates" JSONB NOT NULL,
    "taskKind" TEXT NOT NULL,
    "ruleModelId" TEXT NOT NULL,
    "routerModelId" TEXT NOT NULL,
    "pickedModelId" TEXT,
    "reason" TEXT,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,

    CONSTRAINT "AutoRouterDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoRouterDecision_createdAt_idx" ON "AutoRouterDecision"("createdAt");

-- CreateIndex
CREATE INDEX "AutoRouterDecision_userId_createdAt_idx" ON "AutoRouterDecision"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AutoRouterDecision_conversationId_idx" ON "AutoRouterDecision"("conversationId");

-- CreateIndex
CREATE INDEX "AutoRouterDecision_traceId_idx" ON "AutoRouterDecision"("traceId");

-- AddForeignKey
ALTER TABLE "AutoRouterDecision" ADD CONSTRAINT "AutoRouterDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRouterDecision" ADD CONSTRAINT "AutoRouterDecision_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

