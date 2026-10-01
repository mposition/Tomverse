-- Dark AMUX v4 catalog. No seed rows, service switch or live CLI calls.
-- Applying this migration requires a separate operator-approved rollout.
CREATE TABLE "AmuxIdeaFrontierModelApproval" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "allowedEfforts" TEXT[] NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvalAuditLogId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revocationAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaFrontierModelApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_identity_check" CHECK (
        "id" ~ '^[A-Za-z0-9_-]{8,100}$' AND
        "approvedByUserId" ~ '^[A-Za-z0-9_-]{8,100}$' AND
        "approvalAuditLogId" ~ '^[A-Za-z0-9_-]{8,100}$'
    ),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_provider_check" CHECK (
        "provider" IN ('openai', 'anthropic')
    ),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_model_check" CHECK (
        "modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    ),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_efforts_check" CHECK (
        cardinality("allowedEfforts") BETWEEN 1 AND 6 AND
        array_position("allowedEfforts", NULL) IS NULL AND
        "allowedEfforts" <@ ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra']::TEXT[]
    ),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_version_check" CHECK ("version" > 0),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_status_check" CHECK (
        "status" IN ('approved', 'revoked')
    ),
    CONSTRAINT "AmuxIdeaFrontierModelApproval_shape_check" CHECK (
        ("status" = 'approved' AND "revokedAt" IS NULL AND
         "revokedByUserId" IS NULL AND "revocationAuditLogId" IS NULL) OR
        ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND
         "revokedAt" >= "approvedAt" AND "revokedByUserId" IS NOT NULL AND
         "revokedByUserId" ~ '^[A-Za-z0-9_-]{8,100}$' AND
         "revocationAuditLogId" ~ '^[A-Za-z0-9_-]{8,100}$' AND
         "revocationAuditLogId" <> "approvalAuditLogId")
    )
);

CREATE UNIQUE INDEX "AmuxIdeaFrontierModelApproval_provider_modelId_version_key"
    ON "AmuxIdeaFrontierModelApproval"("provider", "modelId", "version");
CREATE UNIQUE INDEX "AmuxIdeaFrontierModelApproval_approvalAuditLogId_key"
    ON "AmuxIdeaFrontierModelApproval"("approvalAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaFrontierModelApproval_revocationAuditLogId_key"
    ON "AmuxIdeaFrontierModelApproval"("revocationAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaFrontierModelApproval_one_active_model"
    ON "AmuxIdeaFrontierModelApproval"("provider", "modelId")
    WHERE "status" = 'approved';
CREATE INDEX "AmuxIdeaFrontierModelApproval_provider_modelId_status_idx"
    ON "AmuxIdeaFrontierModelApproval"("provider", "modelId", "status");

ALTER TABLE "AmuxIdeaFrontierModelApproval"
    ADD CONSTRAINT "AmuxIdeaFrontierModelApproval_approvalAuditLogId_fkey"
    FOREIGN KEY ("approvalAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxIdeaFrontierModelApproval"
    ADD CONSTRAINT "AmuxIdeaFrontierModelApproval_revocationAuditLogId_fkey"
    FOREIGN KEY ("revocationAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION amux_v4_frontier_model_approval_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    audit_row public."AdminAuditLog"%ROWTYPE;
    latest_version INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'approved' OR NEW."revokedAt" IS NOT NULL OR
           NEW."revokedByUserId" IS NOT NULL OR NEW."revocationAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'amux_v4_frontier_insert_refused';
        END IF;
        IF (SELECT COUNT(DISTINCT effort) FROM unnest(NEW."allowedEfforts") AS effort)
           <> cardinality(NEW."allowedEfforts") THEN
            RAISE EXCEPTION 'amux_v4_frontier_duplicate_effort_refused';
        END IF;
        SELECT * INTO audit_row FROM public."AdminAuditLog"
         WHERE "id" = NEW."approvalAuditLogId" FOR SHARE;
        IF NOT FOUND OR audit_row."actorUserId" IS DISTINCT FROM NEW."approvedByUserId" OR
           audit_row."action" <> 'amux.idea.frontier_model.approved' OR
           audit_row."targetType" <> 'AmuxIdeaFrontierModelApproval' OR
           audit_row."targetId" IS DISTINCT FROM NEW."id" OR
           (audit_row."entryHash" ~ '^[a-f0-9]{64}$') IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'amux_v4_frontier_approval_audit_refused';
        END IF;
        PERFORM pg_advisory_xact_lock(
            hashtextextended('amux-v4-frontier:' || NEW."provider" || ':' || NEW."modelId", 0)
        );
        SELECT COALESCE(MAX("version"), 0) INTO latest_version
          FROM public."AmuxIdeaFrontierModelApproval"
         WHERE "provider" = NEW."provider" AND "modelId" = NEW."modelId";
        IF NEW."version" <> latest_version + 1 THEN
            RAISE EXCEPTION 'amux_v4_frontier_version_refused';
        END IF;
        NEW."approvedAt" := audit_row."createdAt";
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."status" <> 'approved' OR NEW."status" <> 'revoked' OR
           NEW."id" IS DISTINCT FROM OLD."id" OR
           NEW."provider" IS DISTINCT FROM OLD."provider" OR
           NEW."modelId" IS DISTINCT FROM OLD."modelId" OR
           NEW."allowedEfforts" IS DISTINCT FROM OLD."allowedEfforts" OR
           NEW."version" IS DISTINCT FROM OLD."version" OR
           NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR
           NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId" OR
           NEW."approvalAuditLogId" IS DISTINCT FROM OLD."approvalAuditLogId" OR
           NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
           NEW."revokedByUserId" IS NULL OR NEW."revocationAuditLogId" IS NULL THEN
            RAISE EXCEPTION 'amux_v4_frontier_update_refused';
        END IF;
        SELECT * INTO audit_row FROM public."AdminAuditLog"
         WHERE "id" = NEW."revocationAuditLogId" FOR SHARE;
        IF NOT FOUND OR audit_row."actorUserId" IS DISTINCT FROM NEW."revokedByUserId" OR
           audit_row."action" <> 'amux.idea.frontier_model.revoked' OR
           audit_row."targetType" <> 'AmuxIdeaFrontierModelApproval' OR
           audit_row."targetId" IS DISTINCT FROM NEW."id" OR
           (audit_row."entryHash" ~ '^[a-f0-9]{64}$') IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'amux_v4_frontier_revocation_audit_refused';
        END IF;
        NEW."revokedAt" := audit_row."createdAt";
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'amux_v4_frontier_delete_refused';
END;
$$;

CREATE TRIGGER "AmuxIdeaFrontierModelApproval_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaFrontierModelApproval"
    FOR EACH ROW EXECUTE FUNCTION amux_v4_frontier_model_approval_guard();

CREATE FUNCTION amux_v4_frontier_model_no_truncate()
RETURNS trigger LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
SET row_security = off AS $$
BEGIN
    -- A CASCADE from an unrelated test fixture may reach this empty dark
    -- catalog. A populated approval history must never be truncated. Under
    -- READ COMMITTED, the volatile query takes a fresh snapshot after the
    -- ACCESS EXCLUSIVE lock; stronger isolation cannot use this exception.
    IF current_setting('transaction_isolation') <> 'read committed' OR
       EXISTS (SELECT 1 FROM public."AmuxIdeaFrontierModelApproval" LIMIT 1) THEN
        RAISE EXCEPTION 'amux_v4_frontier_truncate_refused';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "AmuxIdeaFrontierModelApproval_no_truncate"
    BEFORE TRUNCATE ON "AmuxIdeaFrontierModelApproval"
    FOR EACH STATEMENT EXECUTE FUNCTION amux_v4_frontier_model_no_truncate();
