-- AMUX v4 idea-analysis cost namespace. Additive and dark: no seed row,
-- reservation writer, provider call or operational switch is enabled here.
-- The approved monthly ceiling is USD 50, stored in micro-USD. Subscription
-- CLI usage is an API-conversion shadow estimate, never a user credit charge.

BEGIN;

CREATE TABLE "AmuxIdeaAnalysisBudgetWindow" (
    "namespace" TEXT NOT NULL,
    "monthStart" TIMESTAMP(3) NOT NULL,
    "limitMicroUsd" BIGINT NOT NULL,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_pkey" PRIMARY KEY ("namespace", "monthStart"),
    CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_namespace_check" CHECK (
        "namespace" = 'agent/amux-intake'
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_month_check" CHECK (
        "monthStart" = date_trunc('month', "monthStart")
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_amount_check" CHECK (
        "limitMicroUsd" = 50000000 AND
        "spentMicroUsd" >= 0 AND "reservedMicroUsd" >= 0 AND
        "reservedMicroUsd" <= "limitMicroUsd"
    )
);

CREATE TABLE "AmuxIdeaAnalysisBudgetHold" (
    "id" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "monthStart" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "inputTokensCap" INTEGER NOT NULL,
    "outputTokensCap" INTEGER NOT NULL,
    "inputMicroUsdPerMillion" INTEGER NOT NULL,
    "outputMicroUsdPerMillion" INTEGER NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "settledMicroUsd" BIGINT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_identity_check" CHECK (
        length("id") BETWEEN 1 AND 128 AND
        length("previewId") BETWEEN 1 AND 128 AND
        length("modelId") BETWEEN 1 AND 120 AND
        length("pricingVersion") BETWEEN 1 AND 160
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_mode_check" CHECK (
        "mode" IN ('subscription_cli', 'api')
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_provider_check" CHECK (
        "provider" IN ('openai', 'anthropic')
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_amount_check" CHECK (
        "inputTokensCap" > 0 AND "outputTokensCap" > 0 AND
        "inputMicroUsdPerMillion" > 0 AND "outputMicroUsdPerMillion" > 0 AND
        "reservedMicroUsd" > 0 AND "reservedMicroUsd" <= 50000000 AND
        ("settledMicroUsd" IS NULL OR "settledMicroUsd" >= 0) AND
        (("inputTokens" IS NULL AND "outputTokens" IS NULL) OR
         ("inputTokens" IS NOT NULL AND "inputTokens" >= 0 AND
          "outputTokens" IS NOT NULL AND "outputTokens" >= 0))
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_status_check" CHECK (
        "status" IN ('reserved', 'in_flight', 'succeeded', 'failed',
            'outcome_unknown', 'owner_consumed', 'released')
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_lifecycle_check" CHECK ((
        ("status" = 'reserved' AND "dispatchedAt" IS NULL AND
            "closedAt" IS NULL AND "settledMicroUsd" IS NULL AND
            "inputTokens" IS NULL) OR
        ("status" IN ('in_flight', 'outcome_unknown') AND
            "dispatchedAt" IS NOT NULL AND "closedAt" IS NULL AND
            "settledMicroUsd" IS NULL AND "inputTokens" IS NULL) OR
        ("status" IN ('succeeded', 'failed') AND
            "dispatchedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND
            "closedAt" >= "dispatchedAt" AND "settledMicroUsd" > 0 AND
            "inputTokens" IS NOT NULL) OR
        ("status" = 'owner_consumed' AND "dispatchedAt" IS NOT NULL AND
            "closedAt" IS NOT NULL AND "closedAt" >= "dispatchedAt" AND
            "settledMicroUsd" = "reservedMicroUsd" AND "inputTokens" IS NULL) OR
        ("status" = 'released' AND "dispatchedAt" IS NULL AND
            "closedAt" IS NOT NULL AND
            "closedAt" >= "createdAt" AND "settledMicroUsd" = 0 AND
            "inputTokens" IS NULL)
        ) IS TRUE
    ),
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_window_fkey"
        FOREIGN KEY ("namespace", "monthStart")
        REFERENCES "AmuxIdeaAnalysisBudgetWindow"("namespace", "monthStart")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaAnalysisBudgetHold_preview_fkey"
        FOREIGN KEY ("previewId") REFERENCES "AmuxIdeaTransferPreview"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AmuxIdeaAnalysisBudgetHold_previewId_key"
    ON "AmuxIdeaAnalysisBudgetHold"("previewId");
CREATE INDEX "AmuxIdeaAnalysisBudgetHold_window_status_idx"
    ON "AmuxIdeaAnalysisBudgetHold"("namespace", "monthStart", "status");

COMMIT;
