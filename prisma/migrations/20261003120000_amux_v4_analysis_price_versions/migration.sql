-- Dark AMUX v4 idea-analysis price evidence. No price, approval or call is
-- seeded. The owner must approve an exact version through canonical audit.
BEGIN;

CREATE TABLE "AmuxIdeaAnalysisPriceVersion" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "inputTokensCap" INTEGER NOT NULL,
    "outputTokensCap" INTEGER NOT NULL,
    "inputMicroUsdPerMillion" INTEGER NOT NULL,
    "outputMicroUsdPerMillion" INTEGER NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3) NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvalAuditLogId" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revocationAuditLogId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_identity_check" CHECK (
        length("id") BETWEEN 1 AND 128 AND
        length("modelId") BETWEEN 1 AND 120 AND
        length("approvedByUserId") BETWEEN 1 AND 128 AND
        "evidenceDigest" ~ '^[a-f0-9]{64}$' AND "version" > 0
    ),
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_provider_check" CHECK (
        "provider" IN ('openai', 'anthropic')
    ),
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_mode_check" CHECK (
        "mode" IN ('subscription_cli', 'api')
    ),
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_values_check" CHECK (
        "inputTokensCap" > 0 AND "outputTokensCap" > 0 AND
        "inputMicroUsdPerMillion" > 0 AND
        "outputMicroUsdPerMillion" > 0 AND
        "verifiedAt" <= "approvedAt" AND "approvedAt" < "expiresAt"
    ),
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_lifecycle_check" CHECK ((
        ("status" = 'approved' AND "revokedAt" IS NULL AND
            "revocationAuditLogId" IS NULL) OR
        ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND
            "revokedAt" >= "approvedAt" AND "revocationAuditLogId" IS NOT NULL)
        ) IS TRUE
    ),
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_approvalAudit_fkey"
        FOREIGN KEY ("approvalAuditLogId") REFERENCES "AdminAuditLog"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaAnalysisPriceVersion_revocationAudit_fkey"
        FOREIGN KEY ("revocationAuditLogId") REFERENCES "AdminAuditLog"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AmuxIdeaAnalysisPriceVersion_provider_model_mode_version_key"
    ON "AmuxIdeaAnalysisPriceVersion"("provider", "modelId", "mode", "version");
CREATE UNIQUE INDEX "AmuxIdeaAnalysisPriceVersion_one_active_key"
    ON "AmuxIdeaAnalysisPriceVersion"("provider", "modelId", "mode")
    WHERE "status" = 'approved';
CREATE UNIQUE INDEX "AmuxIdeaAnalysisPriceVersion_approvalAuditLogId_key"
    ON "AmuxIdeaAnalysisPriceVersion"("approvalAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaAnalysisPriceVersion_revocationAuditLogId_key"
    ON "AmuxIdeaAnalysisPriceVersion"("revocationAuditLogId");
CREATE INDEX "AmuxIdeaAnalysisPriceVersion_lookup_idx"
    ON "AmuxIdeaAnalysisPriceVersion"("provider", "modelId", "mode", "status");

CREATE FUNCTION "amux_idea_analysis_price_version_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'price version deletion is forbidden'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'AmuxIdeaAnalysisPriceVersion_immutable_check';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'approved' THEN
            RAISE EXCEPTION 'price version must start approved'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'AmuxIdeaAnalysisPriceVersion_immutable_check';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" <> 'approved' OR NEW."status" <> 'revoked' OR
       NEW."revokedAt" IS NULL OR NEW."revocationAuditLogId" IS NULL OR
       ROW(NEW."id", NEW."provider", NEW."modelId", NEW."mode",
           NEW."version", NEW."inputTokensCap", NEW."outputTokensCap",
           NEW."inputMicroUsdPerMillion", NEW."outputMicroUsdPerMillion",
           NEW."evidenceDigest", NEW."verifiedAt", NEW."expiresAt",
           NEW."approvedAt", NEW."approvedByUserId", NEW."approvalAuditLogId",
           NEW."createdAt") IS DISTINCT FROM
       ROW(OLD."id", OLD."provider", OLD."modelId", OLD."mode",
           OLD."version", OLD."inputTokensCap", OLD."outputTokensCap",
           OLD."inputMicroUsdPerMillion", OLD."outputMicroUsdPerMillion",
           OLD."evidenceDigest", OLD."verifiedAt", OLD."expiresAt",
           OLD."approvedAt", OLD."approvedByUserId", OLD."approvalAuditLogId",
           OLD."createdAt") THEN
        RAISE EXCEPTION 'price version may only be revoked once'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'AmuxIdeaAnalysisPriceVersion_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaAnalysisPriceVersion_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaAnalysisPriceVersion"
    FOR EACH ROW EXECUTE FUNCTION "amux_idea_analysis_price_version_guard"();

ALTER TABLE "AmuxIdeaAnalysisBudgetHold"
    ADD COLUMN "priceVersionId" TEXT;
ALTER TABLE "AmuxIdeaAnalysisBudgetHold"
    ADD CONSTRAINT "AmuxIdeaAnalysisBudgetHold_priceVersion_fkey"
    FOREIGN KEY ("priceVersionId") REFERENCES "AmuxIdeaAnalysisPriceVersion"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Existing dark/synthetic holds need separate provenance reconciliation before
-- validation. PostgreSQL still enforces this check for every new hold.
ALTER TABLE "AmuxIdeaAnalysisBudgetHold"
    ADD CONSTRAINT "AmuxIdeaAnalysisBudgetHold_new_price_required_check"
    CHECK ("priceVersionId" IS NOT NULL) NOT VALID;
CREATE INDEX "AmuxIdeaAnalysisBudgetHold_priceVersionId_idx"
    ON "AmuxIdeaAnalysisBudgetHold"("priceVersionId");

COMMIT;
