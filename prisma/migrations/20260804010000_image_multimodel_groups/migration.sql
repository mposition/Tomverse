-- Multi-model image comparison storage, v2 (policy §11/§14 of
-- docs/policy/image-generation.md, approved 2026-08-03).
--
-- Forward-only, backfill-inclusive: every existing v1 generation becomes a
-- 1-target group in this same migration so there is exactly one read path
-- afterwards (§14 forbids a long-lived nullable legacy path). v1 was
-- provably single-model (gpt-image-2/openai are the column defaults every
-- v1 row carries), so the financial identity backfill is an inference from
-- that fact and is labeled as such via identitySource, never silently mixed
-- with recorded values.
--
-- Group state is deliberately NOT a column anywhere here: it derives from
-- each target's current attempt (lib/imageGenerationStateCore.ts), so it
-- can never drift from the attempts it summarizes.

-- CreateTable: one user action fanned out to N models.
CREATE TABLE "ImageGenerationGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "groupIdempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageGenerationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a logical model slot; retries append attempts under it.
CREATE TABLE "ImageGenerationTarget" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "currentGenerationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageGenerationTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageGenerationGroup_userId_groupIdempotencyKey_key"
    ON "ImageGenerationGroup"("userId", "groupIdempotencyKey");
CREATE INDEX "ImageGenerationGroup_conversationId_createdAt_idx"
    ON "ImageGenerationGroup"("conversationId", "createdAt");
CREATE UNIQUE INDEX "ImageGenerationTarget_currentGenerationId_key"
    ON "ImageGenerationTarget"("currentGenerationId");
CREATE UNIQUE INDEX "ImageGenerationTarget_groupId_modelId_key"
    ON "ImageGenerationTarget"("groupId", "modelId");

ALTER TABLE "ImageGenerationGroup"
    ADD CONSTRAINT "ImageGenerationGroup_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageGenerationGroup"
    ADD CONSTRAINT "ImageGenerationGroup_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageGenerationTarget"
    ADD CONSTRAINT "ImageGenerationTarget_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "ImageGenerationGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (§14): one group + one target per existing v1 generation. The
-- group inherits the generation's idempotency key, preserving the v1
-- (userId, idempotencyKey) request-identity semantics at group level.
INSERT INTO "ImageGenerationGroup"
    ("id", "userId", "conversationId", "groupIdempotencyKey", "createdAt")
SELECT 'imggrp_v1_' || g."id", g."userId", g."conversationId",
       g."idempotencyKey", g."createdAt"
FROM "ImageGeneration" g;

INSERT INTO "ImageGenerationTarget"
    ("id", "groupId", "provider", "modelId", "currentGenerationId", "createdAt")
SELECT 'imgtgt_v1_' || g."id", 'imggrp_v1_' || g."id",
       g."provider", g."modelId", g."id", g."createdAt"
FROM "ImageGeneration" g;

-- AlterTable (ImageGeneration): attempt identity. Added nullable, filled by
-- the backfill above, then locked NOT NULL -- no nullable legacy path.
ALTER TABLE "ImageGeneration"
    ADD COLUMN "groupId" TEXT,
    ADD COLUMN "targetId" TEXT,
    ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "retryOfGenerationId" TEXT,
    ADD COLUMN "retryIdempotencyKey" TEXT;

UPDATE "ImageGeneration"
SET "groupId" = 'imggrp_v1_' || "id",
    "targetId" = 'imgtgt_v1_' || "id";

ALTER TABLE "ImageGeneration"
    ALTER COLUMN "groupId" SET NOT NULL,
    ALTER COLUMN "targetId" SET NOT NULL;

CREATE UNIQUE INDEX "ImageGeneration_targetId_retryIdempotencyKey_key"
    ON "ImageGeneration"("targetId", "retryIdempotencyKey");
CREATE INDEX "ImageGeneration_groupId_idx" ON "ImageGeneration"("groupId");

ALTER TABLE "ImageGeneration"
    ADD CONSTRAINT "ImageGeneration_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "ImageGenerationTarget"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageGenerationTarget"
    ADD CONSTRAINT "ImageGenerationTarget_currentGenerationId_fkey"
    FOREIGN KEY ("currentGenerationId") REFERENCES "ImageGeneration"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable (ImageCreditReservation): the permanent financial record gains
-- the identity snapshot (§12). provider/modelId land with the v1 defaults so
-- every existing row is filled, then the defaults are DROPPED: v2 code must
-- write identity explicitly, a silent default here would be the exact
-- "invented value" failure mode §8 forbids for budgets.
ALTER TABLE "ImageCreditReservation"
    ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'openai',
    ADD COLUMN "modelId" TEXT NOT NULL DEFAULT 'gpt-image-2',
    ADD COLUMN "groupId" TEXT,
    ADD COLUMN "targetId" TEXT,
    ADD COLUMN "identitySource" TEXT NOT NULL DEFAULT 'inferred_v1_backfill';

-- Rows with a surviving generation get exact group/target snapshots; orphan
-- financial rows (generation deleted) keep NULL group/target but their
-- provider/model identity is still the v1 single-model inference.
UPDATE "ImageCreditReservation" r
SET "groupId" = g."groupId",
    "targetId" = g."targetId"
FROM "ImageGeneration" g
WHERE g."id" = r."generationId";

ALTER TABLE "ImageCreditReservation"
    ALTER COLUMN "provider" DROP DEFAULT,
    ALTER COLUMN "modelId" DROP DEFAULT,
    ALTER COLUMN "identitySource" SET DEFAULT 'recorded';

ALTER TABLE "ImageCreditReservation"
    ADD CONSTRAINT "ImageCreditReservation_identitySource_check"
    CHECK ("identitySource" IN ('recorded', 'inferred_v1_backfill'));
