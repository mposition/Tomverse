ALTER TABLE "AdminActionApproval"
ADD COLUMN "payloadHash" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "consumedAt" TIMESTAMP(3),
ADD COLUMN "consumedById" TEXT,
ADD COLUMN "consumedByEmail" TEXT;

UPDATE "AdminActionApproval"
SET
  "payloadHash" = md5(COALESCE("payload"::text, 'null')),
  "expiresAt" = "createdAt" + INTERVAL '30 minutes'
WHERE "payloadHash" IS NULL OR "expiresAt" IS NULL;

ALTER TABLE "AdminActionApproval"
ALTER COLUMN "payloadHash" SET NOT NULL,
ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE INDEX "AdminActionApproval_status_expiresAt_idx"
ON "AdminActionApproval"("status", "expiresAt");

CREATE INDEX "AdminActionApproval_payloadHash_idx"
ON "AdminActionApproval"("payloadHash");
