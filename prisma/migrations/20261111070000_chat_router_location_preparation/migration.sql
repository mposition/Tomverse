CREATE TABLE "ChatRouterLocationPreparation" (
    "conversationId" TEXT NOT NULL,
    "sourceUserMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "ChatRouterLocationPreparation_pkey"
        PRIMARY KEY ("conversationId", "sourceUserMessageId", "assistantMessageId"),
    CONSTRAINT "ChatRouterLocationPreparation_conversationId_fkey"
        FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ChatRouterLocationPreparation_expiresAt_idx"
    ON "ChatRouterLocationPreparation"("expiresAt");
