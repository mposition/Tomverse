CREATE TABLE "MessageProviderContext" (
    "messageId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "responseMessages" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageProviderContext_pkey" PRIMARY KEY ("messageId")
);

CREATE INDEX "MessageProviderContext_modelId_idx"
ON "MessageProviderContext"("modelId");

ALTER TABLE "MessageProviderContext"
ADD CONSTRAINT "MessageProviderContext_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
