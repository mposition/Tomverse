ALTER TABLE "AdminAuditLog"
  ADD COLUMN "previousHash" TEXT,
  ADD COLUMN "entryHash" TEXT;

CREATE UNIQUE INDEX "AdminAuditLog_entryHash_key" ON "AdminAuditLog"("entryHash");
CREATE INDEX "AdminAuditLog_createdAt_entryHash_idx" ON "AdminAuditLog"("createdAt", "entryHash");
