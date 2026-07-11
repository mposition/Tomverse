CREATE TABLE "BillingPlan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "monthlyPriceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "stripeProductId" TEXT,
  "stripePriceId" TEXT,
  "dailyMessageLimit" INTEGER NOT NULL DEFAULT 0,
  "monthlyMessageLimit" INTEGER NOT NULL DEFAULT 0,
  "maxModels" INTEGER NOT NULL DEFAULT 3,
  "allowAttachments" BOOLEAN NOT NULL DEFAULT true,
  "allowSharing" BOOLEAN NOT NULL DEFAULT true,
  "allowDownloads" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingPromotion" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "discountPercent" INTEGER NOT NULL,
  "durationMonths" INTEGER NOT NULL,
  "appliesToPlanIds" TEXT NOT NULL DEFAULT '[]',
  "stripeCouponId" TEXT,
  "stripePromotionCodeId" TEXT,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPromotion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPromotion_code_key" ON "BillingPromotion"("code");
CREATE INDEX "BillingPlan_tier_idx" ON "BillingPlan"("tier");
CREATE INDEX "BillingPlan_isActive_sortOrder_idx" ON "BillingPlan"("isActive", "sortOrder");
CREATE INDEX "BillingPromotion_isActive_idx" ON "BillingPromotion"("isActive");
CREATE INDEX "BillingPromotion_startsAt_endsAt_idx" ON "BillingPromotion"("startsAt", "endsAt");

INSERT INTO "BillingPlan" (
  "id", "name", "tier", "monthlyPriceCents", "currency", "dailyMessageLimit",
  "monthlyMessageLimit", "maxModels", "allowAttachments", "allowSharing", "allowDownloads",
  "isActive", "sortOrder", "metadata", "updatedAt"
)
VALUES
  ('free', 'Free', 'Free', 0, 'USD', 100, 2000, 3, true, true, true, true, 10,
   '{"description":"Light daily usage for signed-in users."}'::jsonb, CURRENT_TIMESTAMP),
  ('pro', 'Pro', 'Pro', 1500, 'USD', 500, 10000, 3, true, true, true, true, 20,
   '{"description":"Everyday multi-model comparison."}'::jsonb, CURRENT_TIMESTAMP),
  ('max', 'Max', 'Max', 2500, 'USD', 0, 50000, 3, true, true, true, true, 30,
   '{"description":"No daily message limit with monthly fair-use protection."}'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "BillingPromotion" (
  "id", "code", "discountPercent", "durationMonths", "appliesToPlanIds", "isActive", "updatedAt"
)
VALUES (
  'promo_tomverse50', 'TOMVERSE50', 50, 3, '["pro","max"]', true, CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;
