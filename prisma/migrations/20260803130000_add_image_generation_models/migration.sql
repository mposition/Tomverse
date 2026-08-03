-- Image generation work mode: data model and storage lifecycle.
--
-- Four decisions are load-bearing here (docs/policy/image-generation.md):
--
--   * `Conversation.kind` stays a TEXT with a default, like every other
--     discriminator in this schema. Existing rows all become "chat"; "image"
--     rows are only ever created inside the image generation reservation
--     transaction, never by the conversation create endpoint.
--   * `ImageGeneration` is the operational record and cascades with its
--     conversation. `ImageCreditReservation` is the financial record and
--     deliberately has NO conversation or generation foreign key -- deleting
--     a chat must not erase the pricing snapshot, the per-lot reservation
--     payload a crash recovery needs, or the provider request id an audit
--     needs. Only the user link exists, and it detaches (SET NULL) the way
--     ChatCreditReservation already does.
--   * `ImageAssetCleanup` is the DB-first deletion tombstone: conversation
--     deletion enqueues R2 keys here in the same transaction that removes
--     the rows, and the fifteen-minute maintenance sweep deletes the objects
--     idempotently afterwards. R2 is never deleted ahead of the database.
--   * `ImageGeneration.status` includes `settling`, the conditional
--     exactly-once claim that keeps the worker and the reconciliation sweep
--     from settling or refunding the same generation twice.

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'chat';

CREATE INDEX IF NOT EXISTS "Conversation_userId_kind_idx"
  ON "Conversation" ("userId", "kind");

CREATE TABLE IF NOT EXISTS "ImageGeneration" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "preset" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'openai',
  "modelId" TEXT NOT NULL DEFAULT 'gpt-image-2',
  "size" TEXT NOT NULL,
  "quality" TEXT NOT NULL,
  "backgroundMode" TEXT NOT NULL DEFAULT 'opaque',
  "outputFormat" TEXT NOT NULL DEFAULT 'png',
  "moderationMode" TEXT NOT NULL DEFAULT 'auto',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "failurePhase" TEXT,
  "publicErrorCode" TEXT,
  "internalErrorDetail" TEXT,
  "providerRequestId" TEXT,
  "leaseId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImageGeneration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageGeneration_userId_idempotencyKey_key"
  ON "ImageGeneration" ("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "ImageGeneration_status_updatedAt_idx"
  ON "ImageGeneration" ("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "ImageGeneration_conversationId_createdAt_idx"
  ON "ImageGeneration" ("conversationId", "createdAt");

ALTER TABLE "ImageGeneration"
  ADD CONSTRAINT "ImageGeneration_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageGeneration"
  ADD CONSTRAINT "ImageGeneration_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ImageAsset" (
  "id" TEXT NOT NULL,
  "generationId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "r2Key" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "provenancePreserved" BOOLEAN NOT NULL DEFAULT true,
  "thumbnailRetryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageAsset_r2Key_key"
  ON "ImageAsset" ("r2Key");
CREATE UNIQUE INDEX IF NOT EXISTS "ImageAsset_generationId_role_key"
  ON "ImageAsset" ("generationId", "role");
CREATE INDEX IF NOT EXISTS "ImageAsset_status_updatedAt_idx"
  ON "ImageAsset" ("status", "updatedAt");

ALTER TABLE "ImageAsset"
  ADD CONSTRAINT "ImageAsset_generationId_fkey"
  FOREIGN KEY ("generationId") REFERENCES "ImageGeneration" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ImageAssetCleanup" (
  "id" TEXT NOT NULL,
  "r2Key" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "ImageAssetCleanup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageAssetCleanup_r2Key_key"
  ON "ImageAssetCleanup" ("r2Key");
CREATE INDEX IF NOT EXISTS "ImageAssetCleanup_completedAt_createdAt_idx"
  ON "ImageAssetCleanup" ("completedAt", "createdAt");

CREATE TABLE IF NOT EXISTS "ImageCreditReservation" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "generationId" TEXT NOT NULL,
  "conversationId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "outcome" TEXT,
  "preset" TEXT NOT NULL,
  "quality" TEXT NOT NULL,
  "size" TEXT NOT NULL,
  "reservedCredits" INTEGER NOT NULL,
  "planReservedCredits" INTEGER NOT NULL,
  "addOnReservedCredits" INTEGER NOT NULL,
  "reservedCostMicroUsd" BIGINT NOT NULL,
  "reservedFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "settledCredits" INTEGER NOT NULL DEFAULT 0,
  "settledCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "settledFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "pricingVersion" TEXT NOT NULL,
  "costSource" TEXT NOT NULL,
  "pricingSnapshot" JSONB NOT NULL,
  "reservationPayload" JSONB NOT NULL,
  "providerRequestId" TEXT,
  "refundedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "reconciledAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImageCreditReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageCreditReservation_generationId_key"
  ON "ImageCreditReservation" ("generationId");
CREATE INDEX IF NOT EXISTS "ImageCreditReservation_status_createdAt_idx"
  ON "ImageCreditReservation" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ImageCreditReservation_userId_createdAt_idx"
  ON "ImageCreditReservation" ("userId", "createdAt");

ALTER TABLE "ImageCreditReservation"
  ADD CONSTRAINT "ImageCreditReservation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
