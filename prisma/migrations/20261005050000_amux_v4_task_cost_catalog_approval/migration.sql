-- Approved worker/model prices live in an Agent-only namespace. No default
-- catalog is seeded: missing price evidence must hold Task registration.
CREATE TABLE "AmuxV4TaskCostCatalogApproval" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "pricingVersion" TEXT NOT NULL,
  "catalog" JSONB NOT NULL,
  "catalogDigest" TEXT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "approvalAuditLogId" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revocationAuditLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV4TaskCostCatalogApproval_shape_check" CHECK (
    "version" > 0 AND "status" IN ('approved', 'revoked') AND
    length("catalogVersion") BETWEEN 1 AND 160 AND
    length("pricingVersion") BETWEEN 1 AND 160 AND
    "catalogDigest" ~ '^[a-f0-9]{64}$' AND
    "evidenceDigest" ~ '^[a-f0-9]{64}$' AND
    jsonb_typeof("catalog") = 'object' AND
    octet_length("catalog"::text) <= 262144 AND
    (("status" = 'approved' AND "revokedAt" IS NULL AND
      "revocationAuditLogId" IS NULL) OR
     ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND
      "revocationAuditLogId" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "AmuxV4TaskCostCatalogApproval_version_key"
  ON "AmuxV4TaskCostCatalogApproval"("version");
CREATE UNIQUE INDEX "AmuxV4TaskCostCatalogApproval_catalogVersion_key"
  ON "AmuxV4TaskCostCatalogApproval"("catalogVersion");
CREATE UNIQUE INDEX "AmuxV4TaskCostCatalogApproval_approvalAuditLogId_key"
  ON "AmuxV4TaskCostCatalogApproval"("approvalAuditLogId");
CREATE UNIQUE INDEX "AmuxV4TaskCostCatalogApproval_revocationAuditLogId_key"
  ON "AmuxV4TaskCostCatalogApproval"("revocationAuditLogId");

CREATE FUNCTION amux_v4_task_catalog_approval_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task catalog approval cannot be deleted'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4TaskCostCatalogApproval_no_delete_check';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" IS DISTINCT FROM 'approved' OR
       NEW."status" IS DISTINCT FROM 'revoked' OR
       to_jsonb(NEW) - 'status' - 'revokedAt' - 'revocationAuditLogId' - 'updatedAt'
         IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'revokedAt' - 'revocationAuditLogId' - 'updatedAt' OR
       NEW."revokedAt" < OLD."approvedAt" THEN
      RAISE EXCEPTION 'task catalog approval is immutable'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4TaskCostCatalogApproval_immutable_check';
    END IF;
    SELECT * INTO v_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."revocationAuditLogId";
    IF v_audit."id" IS NULL OR
       v_audit."action" IS DISTINCT FROM 'amux.v4.task_catalog.revoke' OR
       v_audit."actorUserId" IS DISTINCT FROM OLD."approvedByUserId" OR
       v_audit."targetType" IS DISTINCT FROM 'AmuxV4TaskCostCatalogApproval' OR
       v_audit."targetId" IS DISTINCT FROM OLD."id" OR
       v_audit."entryHash" IS NULL THEN
      RAISE EXCEPTION 'task catalog revocation audit is missing'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4TaskCostCatalogApproval_audit_check';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_audit FROM "AdminAuditLog"
    WHERE "id" = NEW."approvalAuditLogId";
  IF v_audit."id" IS NULL OR
     v_audit."action" IS DISTINCT FROM 'amux.v4.task_catalog.approve' OR
     v_audit."actorUserId" IS DISTINCT FROM NEW."approvedByUserId" OR
     v_audit."targetType" IS DISTINCT FROM 'AmuxV4TaskCostCatalogApproval' OR
     v_audit."targetId" IS DISTINCT FROM NEW."id" OR
     v_audit."entryHash" IS NULL THEN
    RAISE EXCEPTION 'task catalog approval audit is missing'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4TaskCostCatalogApproval_audit_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amux_v4_task_catalog_approval_guard_row
BEFORE INSERT OR UPDATE OR DELETE ON "AmuxV4TaskCostCatalogApproval"
FOR EACH ROW EXECUTE FUNCTION amux_v4_task_catalog_approval_guard();

CREATE FUNCTION amux_v4_task_catalog_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'task catalog approval cannot be truncated'
    USING ERRCODE = '23514',
      CONSTRAINT = 'AmuxV4TaskCostCatalogApproval_no_truncate_check';
END;
$$;
CREATE TRIGGER amux_v4_task_catalog_no_truncate_trigger
BEFORE TRUNCATE ON "AmuxV4TaskCostCatalogApproval"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v4_task_catalog_no_truncate();
