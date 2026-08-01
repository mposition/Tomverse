-- Baseline migration for the Tomverse schema.
--
-- The migration history could not build this schema from an empty database.
-- 20260704131220_init created only "Conversation" and "Message" -- every other
-- table was created with `prisma db push` before migrations were adopted -- so
-- 20260709120000_align_model_defaults failed on an empty database with
-- `relation "UserSettings" does not exist`. Deploys survived only because
-- staging and production already held the tables, which meant provisioning a
-- new environment, restoring a backup, or building a CI database from
-- migrations was impossible.
--
-- This file replaces that history. The 79 original migrations are kept in
-- prisma/migrations-archive/ for the record; Prisma never reads them.
--
-- Two parts, and the second is the reason this file is not simply generated:
--
--  1. Structure, from `prisma migrate diff --from-empty --to-schema
--     prisma/schema.prisma --script`. Authoritative for tables, columns,
--     defaults, indexes and foreign keys, and verifiable -- applying it leaves
--     `migrate diff --from-schema ... --exit-code` reporting no difference.
--
--  2. CHECK constraints, which schema.prisma cannot express and which the
--     generator therefore omits entirely. These were recovered from the
--     archived history by replaying its ADD/DROP sequence, and each one was
--     verified against the original files rather than transcribed: a database
--     built from those files produces byte-identical `pg_get_constraintdef()`
--     output for all ten.
--
-- Deliberately NOT carried over: data. The archived history also backfilled
-- columns, seeded two BillingPromotion rows and wrote one AdminAuditLog entry.
-- Backfills have nothing to act on in an empty database; billing plan defaults
-- are seeded from code by `syncBillingDefaultsToDatabase()`; and a promotion
-- code or a historical security finding is not something a brand-new
-- environment should invent for itself.

CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'Free',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "subscriptionStatus" TEXT,
    "subscriptionCurrentPeriodEnd" TIMESTAMP(3),
    "subscriptionBillingInterval" TEXT,
    "subscriptionCancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "creditDebtCredits" INTEGER NOT NULL DEFAULT 0,
    "creditDebtCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "billingRiskStatus" TEXT NOT NULL DEFAULT 'normal',
    "billingRiskReason" TEXT,
    "billingRiskAt" TIMESTAMP(3),
    "accountStatus" TEXT NOT NULL DEFAULT 'active',
    "accountSuspendedAt" TIMESTAMP(3),
    "accountSuspendedUntil" TIMESTAMP(3),
    "accountSuspensionReason" TEXT,
    "accountSuspendedById" TEXT,
    "accountSuspendedByEmail" TEXT,
    "aiUsageRestricted" BOOLEAN NOT NULL DEFAULT false,
    "aiUsageRestrictedAt" TIMESTAMP(3),
    "aiUsageRestrictedUntil" TIMESTAMP(3),
    "aiUsageRestrictionReason" TEXT,
    "aiUsageRestrictedById" TEXT,
    "aiUsageRestrictedByEmail" TEXT,
    "securityIncidentNote" TEXT,
    "sessionsRevokedAt" TIMESTAMP(3),
    "accountDeletionRequestedAt" TIMESTAMP(3),
    "accountDeletionScheduledFor" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "emailLoginEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sessionsInvalidatedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "language" TEXT NOT NULL DEFAULT 'en',
    "defaultModel" TEXT NOT NULL DEFAULT 'gpt-5-4-mini',
    "preferredTasks" JSONB,
    "preferredPriority" TEXT,
    "usesFilesFrequently" TEXT,
    "modelFinderCompletedAt" TIMESTAMP(3),
    "modelFinderDismissedAt" TIMESTAMP(3),
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "timeZoneInitializedAt" TIMESTAMP(3),
    "timeZoneChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "EmailLoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "linkTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "projectId" TEXT,
    "selectedModels" TEXT NOT NULL DEFAULT '["gpt-5-4-mini"]',
    "disabledPanels" TEXT NOT NULL DEFAULT '[]',
    "webSearchMode" TEXT NOT NULL DEFAULT 'off',
    "shareToken" TEXT,
    "shareEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sharedAt" TIMESTAMP(3),
    "shareSnapshot" JSONB,
    "shareExpiresAt" TIMESTAMP(3),
    "shareRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "password" TEXT,
    "importedGuestKey" TEXT,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'normal',
    "modelId" TEXT,
    "pendingJobId" TEXT,
    "searchMetadata" JSONB,
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComparisonReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "promptMessageId" TEXT NOT NULL,
    "assistantMessageIds" JSONB NOT NULL,
    "reviewerModelId" TEXT NOT NULL,
    "reviewMode" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "usageCredits" INTEGER NOT NULL,
    "inputHash" TEXT NOT NULL,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComparisonReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAnalyticsEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousIdHash" TEXT NOT NULL,
    "sessionIdHash" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "utmMedium" TEXT NOT NULL,
    "utmCampaign" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "modelCount" INTEGER NOT NULL,
    "plan" TEXT NOT NULL,
    "properties" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatUsageBucket" (
    "key" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatUsageBucket_pkey" PRIMARY KEY ("key","period","periodStart")
);

-- CreateTable
CREATE TABLE "ProviderErrorEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "phase" TEXT NOT NULL,
    "diagnosticCode" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "errorName" TEXT,
    "errorCode" TEXT,
    "httpStatus" INTEGER,
    "retryable" BOOLEAN,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderErrorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderHealthState" (
    "provider" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastProbeSuccessAt" TIMESTAMP(3),
    "lastProbeFailureAt" TIMESTAMP(3),
    "consecutiveProbeFailures" INTEGER NOT NULL DEFAULT 0,
    "lastVerificationSuccessAt" TIMESTAMP(3),
    "lastVerificationFailureAt" TIMESTAMP(3),
    "lastRecoveryAt" TIMESTAMP(3),
    "lastRecoveryCheckId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderHealthState_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "ProviderProbeResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "errorClassification" TEXT,
    "diagnosticCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderProbeResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatRequestLease" (
    "id" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRequestLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatLimitDecisionEvent" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "userId" TEXT,
    "plan" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "errorCode" TEXT,
    "limitLayer" TEXT,
    "limitScope" TEXT,
    "modelIds" TEXT[],
    "enabledTools" TEXT[],
    "estimatedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "pricingVersions" TEXT[],
    "models" JSONB NOT NULL,
    "requiredCredits" INTEGER,
    "availableCredits" INTEGER,
    "usedAllowanceMicroUsd" BIGINT,
    "requiredAllowanceMicroUsd" BIGINT,
    "limitMicroUsd" BIGINT,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "resetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLimitDecisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "monthlyPriceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "annualPriceCents" INTEGER,
    "stripeAnnualPriceId" TEXT,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPromotion" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "discountAmountCents" INTEGER,
    "maxRedemptions" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "durationMonths" INTEGER NOT NULL,
    "fulfillmentType" TEXT NOT NULL DEFAULT 'stripe_subscription',
    "accessDurationDays" INTEGER,
    "appliesToPlanIds" TEXT NOT NULL DEFAULT '[]',
    "stripeCouponId" TEXT,
    "stripePromotionCodeId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "allowAnnualStacking" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPromotionRedemption" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingInterval" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "stripeSubscriptionId" TEXT,
    "clientIpHash" TEXT,
    "paymentMethodFingerprintHash" TEXT,
    "riskFlags" TEXT NOT NULL DEFAULT '[]',
    "accessStartsAt" TIMESTAMP(3),
    "accessEndsAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "expiryNoticeSentAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "productType" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "billingInterval" TEXT,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeSubscriptionId" TEXT,
    "amountPaidMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amountPaidUsdMicroUsd" BIGINT NOT NULL,
    "usdConversionRate" TEXT,
    "usdConversionSource" TEXT NOT NULL,
    "pricingVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "creditsPurchased" INTEGER NOT NULL,
    "fundedCostMicroUsd" BIGINT NOT NULL,
    "amountPaidCents" INTEGER NOT NULL,
    "amountPaidUsdMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "refundedAmountCents" INTEGER NOT NULL DEFAULT 0,
    "revokedCredits" INTEGER NOT NULL DEFAULT 0,
    "revokedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "unrecoveredCredits" INTEGER NOT NULL DEFAULT 0,
    "unrecoveredCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "stripeDisputeId" TEXT,
    "disputeStatus" TEXT,
    "disputeAmountCents" INTEGER NOT NULL DEFAULT 0,
    "disputeRevokedCredits" INTEGER NOT NULL DEFAULT 0,
    "disputeRevokedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "disputeDebtCredits" INTEGER NOT NULL DEFAULT 0,
    "disputeDebtCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "disputeOffsetCredits" INTEGER NOT NULL DEFAULT 0,
    "disputeOffsetCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'paid',
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "source" TEXT NOT NULL,
    "originalCredits" INTEGER NOT NULL,
    "remainingCredits" INTEGER NOT NULL,
    "originalFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "remainingFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creditLotId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "type" TEXT NOT NULL,
    "creditsDelta" INTEGER NOT NULL,
    "fundedCostMicroUsdDelta" BIGINT NOT NULL DEFAULT 0,
    "balanceAfterCredits" INTEGER NOT NULL,
    "balanceAfterFundedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditDebtEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "type" TEXT NOT NULL,
    "creditsDelta" INTEGER NOT NULL,
    "fundedCostMicroUsdDelta" BIGINT NOT NULL DEFAULT 0,
    "balanceAfterCredits" INTEGER NOT NULL,
    "balanceAfterCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditDebtEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatCreditReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subjectKey" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "outcome" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "providerResponseId" TEXT,
    "providerRequestLinkedAt" TIMESTAMP(3),
    "reservationPayload" JSONB NOT NULL,
    "reservedCredits" INTEGER NOT NULL,
    "reservedCostMicroUsd" BIGINT NOT NULL,
    "planReservedCredits" INTEGER NOT NULL,
    "addOnReservedCredits" INTEGER NOT NULL,
    "settledCredits" INTEGER NOT NULL DEFAULT 0,
    "settledCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "settledInputTokens" INTEGER NOT NULL DEFAULT 0,
    "settledCachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "settledOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "pricingSnapshot" JSONB,
    "providerUsageSnapshot" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatCreditReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerplexityAsyncJob" (
    "id" TEXT NOT NULL,
    "perplexityJobId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "resultText" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPolledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerplexityAsyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "message" TEXT NOT NULL,
    "traceId" TEXT,
    "modelId" TEXT,
    "plan" TEXT,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorKind" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "plan" TEXT,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT,
    "subscriptionCurrentPeriodEnd" TIMESTAMP(3),
    "subscriptionBillingInterval" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "adminNote" TEXT,
    "reviewedByUserId" TEXT,
    "stripeRefundId" TEXT,
    "stripeRefundStatus" TEXT,
    "stripeChargeId" TEXT,
    "refundAmountCents" INTEGER,
    "refundCurrency" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequestTimelineEvent" (
    "id" TEXT NOT NULL,
    "refundRequestId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundRequestTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "previousHash" TEXT,
    "entryHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActionApproval" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "payload" JSONB,
    "payloadHash" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedByEmail" TEXT,
    "reviewedById" TEXT,
    "reviewedByEmail" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedById" TEXT,
    "consumedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminActionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNote" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelOverride" (
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "visibleNote" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelOverride_pkey" PRIMARY KEY ("modelId")
);

-- CreateTable
CREATE TABLE "ModelRegistryEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiBaseUrl" TEXT NOT NULL,
    "apiKeyEnvName" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '',
    "bestFor" TEXT NOT NULL DEFAULT '',
    "minimumPlan" TEXT NOT NULL,
    "usageClass" TEXT NOT NULL,
    "creditWeight" INTEGER NOT NULL,
    "publiclyListed" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "operationalReason" TEXT,
    "userVisibleNote" TEXT,
    "replacementModelId" TEXT,
    "catalogDeleted" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT,
    "contextWindowTokens" INTEGER,
    "supportsImage" BOOLEAN NOT NULL DEFAULT false,
    "supportsNativePdf" BOOLEAN NOT NULL DEFAULT false,
    "maxImages" INTEGER,
    "maxBase64ImagePayloadBytes" INTEGER,
    "maxOutputTokens" INTEGER,
    "reservationOutputTokens" INTEGER,
    "inputUsdPerMillionTokens" DOUBLE PRECISION,
    "outputUsdPerMillionTokens" DOUBLE PRECISION,
    "cachedInputPriceMultiplier" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelRegistryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderModelCatalogEntry" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "modelRegistryId" TEXT,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "missingSinceAt" TIMESTAMP(3),
    "consecutiveSeen" INTEGER NOT NULL DEFAULT 0,
    "consecutiveMissing" INTEGER NOT NULL DEFAULT 0,
    "lifecycle" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModelCatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderModelCatalogRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "discoveredCount" INTEGER NOT NULL DEFAULT 0,
    "mappedCount" INTEGER NOT NULL DEFAULT 0,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "lifecycleCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderModelCatalogRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNotificationLog" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "error" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAlertPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "budgetThresholds" TEXT NOT NULL DEFAULT '[50,80,95]',
    "providerFailureThreshold" INTEGER NOT NULL DEFAULT 5,
    "modelFailureThreshold" INTEGER NOT NULL DEFAULT 3,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "notifySlack" BOOLEAN NOT NULL DEFAULT false,
    "notifyDiscord" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminAlertPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSlackTemplate" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "titleTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSlackTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AdminProviderIncident" (
    "id" TEXT NOT NULL,
    "provider" TEXT,
    "modelId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'limited',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "fallbackModelIds" TEXT NOT NULL DEFAULT '[]',
    "previousModelStates" JSONB,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "resolvedById" TEXT,
    "resolvedByEmail" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminProviderIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderHealthCheck" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'configuration',
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "diagnosticCode" TEXT,
    "message" TEXT,
    "traceId" TEXT,
    "recoveryApplied" BOOLEAN NOT NULL DEFAULT false,
    "recoveryAppliedAt" TIMESTAMP(3),
    "previousConsecutiveFailures" INTEGER,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderDailyUsage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT '__provider__',
    "source" TEXT NOT NULL DEFAULT 'internal',
    "date" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "uncachedInputCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "cachedInputCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "outputCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "providerReportedCostMicroUsd" INTEGER,
    "providerReportedUsageJson" JSONB,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCreditConfig" (
    "provider" TEXT NOT NULL,
    "creditMicroUsd" BIGINT NOT NULL,
    "usageBaselineMicroUsd" BIGINT NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCreditConfig_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "ProviderBillingConfig" (
    "provider" TEXT NOT NULL,
    "pricingModel" TEXT NOT NULL,
    "settlementModel" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "monthlyLimitMicroUsd" BIGINT,
    "source" TEXT NOT NULL DEFAULT 'admin_verified',
    "verifiedAt" TIMESTAMP(3),
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderBillingConfig_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "InfrastructureCreditConfig" (
    "service" TEXT NOT NULL,
    "creditMicroUsd" BIGINT NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructureCreditConfig_pkey" PRIMARY KEY ("service")
);

-- CreateTable
CREATE TABLE "StripeWebhookEventLog" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "replayedAt" TIMESTAMP(3),
    "replayedById" TEXT,
    "replayedByEmail" TEXT,
    "payloadSummary" JSONB,

    CONSTRAINT "StripeWebhookEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRetentionRun" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminRetentionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminOperationReport" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recipient" TEXT,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminOperationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJobRun" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "source" TEXT NOT NULL DEFAULT 'internal_api',
    "processedCount" INTEGER,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoFixAttemptedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminOperationalCheckpoint" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "observedAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),
    "detail" TEXT,
    "evidenceUrl" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminOperationalCheckpoint_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "legalHoldReason" TEXT,
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "handledById" TEXT,
    "handledByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "User_plan_id_idx" ON "User"("plan", "id");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "User_subscriptionStatus_subscriptionCurrentPeriodEnd_idx" ON "User"("subscriptionStatus", "subscriptionCurrentPeriodEnd");

-- CreateIndex
CREATE INDEX "User_subscriptionCancelAtPeriodEnd_subscriptionStatus_idx" ON "User"("subscriptionCancelAtPeriodEnd", "subscriptionStatus");

-- CreateIndex
CREATE INDEX "User_billingRiskStatus_idx" ON "User"("billingRiskStatus");

-- CreateIndex
CREATE INDEX "User_accountStatus_accountSuspendedUntil_idx" ON "User"("accountStatus", "accountSuspendedUntil");

-- CreateIndex
CREATE INDEX "User_accountStatus_accountDeletionScheduledFor_idx" ON "User"("accountStatus", "accountDeletionScheduledFor");

-- CreateIndex
CREATE INDEX "User_aiUsageRestricted_aiUsageRestrictedUntil_idx" ON "User"("aiUsageRestricted", "aiUsageRestrictedUntil");

-- CreateIndex
CREATE INDEX "User_creditDebtCredits_idx" ON "User"("creditDebtCredits");

-- CreateIndex
CREATE INDEX "User_creditDebtCostMicroUsd_idx" ON "User"("creditDebtCostMicroUsd");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expires_idx" ON "Session"("expires");

-- CreateIndex
CREATE INDEX "Session_userId_createdAt_idx" ON "Session"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLoginAttempt_linkTokenHash_key" ON "EmailLoginAttempt"("linkTokenHash");

-- CreateIndex
CREATE INDEX "EmailLoginAttempt_email_consumedAt_invalidatedAt_expiresAt_idx" ON "EmailLoginAttempt"("email", "consumedAt", "invalidatedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "EmailLoginAttempt_expiresAt_idx" ON "EmailLoginAttempt"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_shareToken_key" ON "Conversation"("shareToken");

-- CreateIndex
CREATE INDEX "Conversation_userId_projectId_idx" ON "Conversation"("userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_userId_importedGuestKey_key" ON "Conversation"("userId", "importedGuestKey");

-- CreateIndex
CREATE INDEX "ConversationProject_userId_updatedAt_idx" ON "ConversationProject"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationProject_userId_name_key" ON "ConversationProject"("userId", "name");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "ComparisonReview_conversationId_createdAt_idx" ON "ComparisonReview"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ComparisonReview_conversationId_isStale_idx" ON "ComparisonReview"("conversationId", "isStale");

-- CreateIndex
CREATE UNIQUE INDEX "ComparisonReview_userId_inputHash_key" ON "ComparisonReview"("userId", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAnalyticsEvent_dedupeKey_key" ON "ProductAnalyticsEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_eventName_occurredAt_idx" ON "ProductAnalyticsEvent"("eventName", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_userId_occurredAt_idx" ON "ProductAnalyticsEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_anonymousIdHash_occurredAt_idx" ON "ProductAnalyticsEvent"("anonymousIdHash", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_utmSource_utmCampaign_occurredAt_idx" ON "ProductAnalyticsEvent"("utmSource", "utmCampaign", "occurredAt");

-- CreateIndex
CREATE INDEX "ChatUsageBucket_updatedAt_idx" ON "ChatUsageBucket"("updatedAt");

-- CreateIndex
CREATE INDEX "ProviderErrorEvent_provider_createdAt_idx" ON "ProviderErrorEvent"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderErrorEvent_provider_diagnosticCode_createdAt_idx" ON "ProviderErrorEvent"("provider", "diagnosticCode", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderErrorEvent_modelId_createdAt_idx" ON "ProviderErrorEvent"("modelId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderErrorEvent_traceId_idx" ON "ProviderErrorEvent"("traceId");

-- CreateIndex
CREATE INDEX "ProviderHealthState_lastSuccessAt_idx" ON "ProviderHealthState"("lastSuccessAt");

-- CreateIndex
CREATE INDEX "ProviderHealthState_lastProbeSuccessAt_idx" ON "ProviderHealthState"("lastProbeSuccessAt");

-- CreateIndex
CREATE INDEX "ProviderProbeResult_provider_createdAt_idx" ON "ProviderProbeResult"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderProbeResult_provider_modelId_createdAt_idx" ON "ProviderProbeResult"("provider", "modelId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderProbeResult_runId_idx" ON "ProviderProbeResult"("runId");

-- CreateIndex
CREATE INDEX "ChatRequestLease_subjectKey_expiresAt_idx" ON "ChatRequestLease"("subjectKey", "expiresAt");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_traceId_idx" ON "ChatLimitDecisionEvent"("traceId");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_createdAt_idx" ON "ChatLimitDecisionEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_userId_createdAt_idx" ON "ChatLimitDecisionEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_subjectKey_createdAt_idx" ON "ChatLimitDecisionEvent"("subjectKey", "createdAt");

-- CreateIndex
CREATE INDEX "BillingPlan_tier_idx" ON "BillingPlan"("tier");

-- CreateIndex
CREATE INDEX "BillingPlan_isActive_sortOrder_idx" ON "BillingPlan"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPromotion_code_key" ON "BillingPromotion"("code");

-- CreateIndex
CREATE INDEX "BillingPromotion_isActive_idx" ON "BillingPromotion"("isActive");

-- CreateIndex
CREATE INDEX "BillingPromotion_startsAt_endsAt_idx" ON "BillingPromotion"("startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPromotionRedemption_stripeCheckoutSessionId_key" ON "BillingPromotionRedemption"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "BillingPromotionRedemption_promotionId_redeemedAt_idx" ON "BillingPromotionRedemption"("promotionId", "redeemedAt");

-- CreateIndex
CREATE INDEX "BillingPromotionRedemption_promotionId_clientIpHash_redeeme_idx" ON "BillingPromotionRedemption"("promotionId", "clientIpHash", "redeemedAt");

-- CreateIndex
CREATE INDEX "BillingPromotionRedemption_promotionId_paymentMethodFingerp_idx" ON "BillingPromotionRedemption"("promotionId", "paymentMethodFingerprintHash", "redeemedAt");

-- CreateIndex
CREATE INDEX "BillingPromotionRedemption_userId_redeemedAt_idx" ON "BillingPromotionRedemption"("userId", "redeemedAt");

-- CreateIndex
CREATE INDEX "BillingPromotionRedemption_accessEndsAt_reminderSentAt_idx" ON "BillingPromotionRedemption"("accessEndsAt", "reminderSentAt");

-- CreateIndex
CREATE INDEX "BillingPromotionRedemption_accessEndsAt_expiredAt_idx" ON "BillingPromotionRedemption"("accessEndsAt", "expiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPromotionRedemption_promotionId_userId_key" ON "BillingPromotionRedemption"("promotionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingTransaction_stripeCheckoutSessionId_key" ON "BillingTransaction"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "BillingTransaction_userId_paidAt_idx" ON "BillingTransaction"("userId", "paidAt");

-- CreateIndex
CREATE INDEX "BillingTransaction_productType_paidAt_idx" ON "BillingTransaction"("productType", "paidAt");

-- CreateIndex
CREATE INDEX "BillingTransaction_currency_paidAt_idx" ON "BillingTransaction"("currency", "paidAt");

-- CreateIndex
CREATE INDEX "BillingTransaction_stripePaymentIntentId_idx" ON "BillingTransaction"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "BillingTransaction_stripeSubscriptionId_idx" ON "BillingTransaction"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_stripeCheckoutSessionId_key" ON "CreditPurchase"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_stripePaymentIntentId_key" ON "CreditPurchase"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_stripeChargeId_key" ON "CreditPurchase"("stripeChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_stripeDisputeId_key" ON "CreditPurchase"("stripeDisputeId");

-- CreateIndex
CREATE INDEX "CreditPurchase_userId_purchasedAt_idx" ON "CreditPurchase"("userId", "purchasedAt");

-- CreateIndex
CREATE INDEX "CreditPurchase_status_purchasedAt_idx" ON "CreditPurchase"("status", "purchasedAt");

-- CreateIndex
CREATE INDEX "CreditPurchase_stripePaymentIntentId_idx" ON "CreditPurchase"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "CreditLot_userId_status_expiresAt_idx" ON "CreditLot"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "CreditLot_purchaseId_idx" ON "CreditLot"("purchaseId");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_userId_createdAt_idx" ON "CreditLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_creditLotId_createdAt_idx" ON "CreditLedgerEntry"("creditLotId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_purchaseId_createdAt_idx" ON "CreditLedgerEntry"("purchaseId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_reservationId_idx" ON "CreditLedgerEntry"("reservationId");

-- CreateIndex
CREATE INDEX "CreditDebtEntry_userId_createdAt_idx" ON "CreditDebtEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditDebtEntry_purchaseId_createdAt_idx" ON "CreditDebtEntry"("purchaseId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditDebtEntry_type_createdAt_idx" ON "CreditDebtEntry"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatCreditReservation_idempotencyKey_key" ON "ChatCreditReservation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ChatCreditReservation_status_expiresAt_idx" ON "ChatCreditReservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ChatCreditReservation_userId_createdAt_idx" ON "ChatCreditReservation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatCreditReservation_traceId_idx" ON "ChatCreditReservation"("traceId");

-- CreateIndex
CREATE INDEX "ChatCreditReservation_providerRequestId_idx" ON "ChatCreditReservation"("providerRequestId");

-- CreateIndex
CREATE INDEX "ChatCreditReservation_providerResponseId_idx" ON "ChatCreditReservation"("providerResponseId");

-- CreateIndex
CREATE UNIQUE INDEX "PerplexityAsyncJob_perplexityJobId_key" ON "PerplexityAsyncJob"("perplexityJobId");

-- CreateIndex
CREATE UNIQUE INDEX "PerplexityAsyncJob_assistantMessageId_key" ON "PerplexityAsyncJob"("assistantMessageId");

-- CreateIndex
CREATE INDEX "PerplexityAsyncJob_status_lastPolledAt_idx" ON "PerplexityAsyncJob"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_type_createdAt_idx" ON "Feedback"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_kind_referenceId_key" ON "NotificationDelivery"("kind", "referenceId");

-- CreateIndex
CREATE INDEX "RefundRequest_status_requestedAt_idx" ON "RefundRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "RefundRequest_userId_requestedAt_idx" ON "RefundRequest"("userId", "requestedAt");

-- CreateIndex
CREATE INDEX "RefundRequest_email_idx" ON "RefundRequest"("email");

-- CreateIndex
CREATE INDEX "RefundRequestTimelineEvent_refundRequestId_createdAt_idx" ON "RefundRequestTimelineEvent"("refundRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "RefundRequestTimelineEvent_eventType_createdAt_idx" ON "RefundRequestTimelineEvent"("eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminAuditLog_entryHash_key" ON "AdminAuditLog"("entryHash");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorUserId_createdAt_idx" ON "AdminAuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_entryHash_idx" ON "AdminAuditLog"("createdAt", "entryHash");

-- CreateIndex
CREATE INDEX "AdminActionApproval_status_createdAt_idx" ON "AdminActionApproval"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionApproval_status_expiresAt_idx" ON "AdminActionApproval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminActionApproval_payloadHash_idx" ON "AdminActionApproval"("payloadHash");

-- CreateIndex
CREATE INDEX "AdminActionApproval_action_createdAt_idx" ON "AdminActionApproval"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActionApproval_targetType_targetId_idx" ON "AdminActionApproval"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminNote_targetType_targetId_createdAt_idx" ON "AdminNote"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminNote_createdById_createdAt_idx" ON "AdminNote"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "ModelOverride_status_idx" ON "ModelOverride"("status");

-- CreateIndex
CREATE INDEX "ModelRegistryEntry_provider_sortOrder_idx" ON "ModelRegistryEntry"("provider", "sortOrder");

-- CreateIndex
CREATE INDEX "ModelRegistryEntry_status_catalogDeleted_idx" ON "ModelRegistryEntry"("status", "catalogDeleted");

-- CreateIndex
CREATE INDEX "ModelRegistryEntry_publiclyListed_enabled_catalogDeleted_idx" ON "ModelRegistryEntry"("publiclyListed", "enabled", "catalogDeleted");

-- CreateIndex
CREATE INDEX "ProviderModelCatalogEntry_provider_status_updatedAt_idx" ON "ProviderModelCatalogEntry"("provider", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ProviderModelCatalogEntry_modelRegistryId_idx" ON "ProviderModelCatalogEntry"("modelRegistryId");

-- CreateIndex
CREATE INDEX "ProviderModelCatalogEntry_status_lastCheckedAt_idx" ON "ProviderModelCatalogEntry"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderModelCatalogEntry_provider_apiModel_key" ON "ProviderModelCatalogEntry"("provider", "apiModel");

-- CreateIndex
CREATE INDEX "ProviderModelCatalogRun_provider_startedAt_idx" ON "ProviderModelCatalogRun"("provider", "startedAt");

-- CreateIndex
CREATE INDEX "ProviderModelCatalogRun_status_startedAt_idx" ON "ProviderModelCatalogRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "AdminNotificationLog_channel_createdAt_idx" ON "AdminNotificationLog"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "AdminNotificationLog_status_createdAt_idx" ON "AdminNotificationLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminNotificationLog_targetType_targetId_idx" ON "AdminNotificationLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminNotificationLog_acknowledgedAt_idx" ON "AdminNotificationLog"("acknowledgedAt");

-- CreateIndex
CREATE INDEX "AdminAlertPolicy_isActive_idx" ON "AdminAlertPolicy"("isActive");

-- CreateIndex
CREATE INDEX "AdminAlertPolicy_provider_idx" ON "AdminAlertPolicy"("provider");

-- CreateIndex
CREATE INDEX "AdminSlackTemplate_enabled_idx" ON "AdminSlackTemplate"("enabled");

-- CreateIndex
CREATE INDEX "AdminProviderIncident_status_createdAt_idx" ON "AdminProviderIncident"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminProviderIncident_provider_status_idx" ON "AdminProviderIncident"("provider", "status");

-- CreateIndex
CREATE INDEX "AdminProviderIncident_modelId_status_idx" ON "AdminProviderIncident"("modelId", "status");

-- CreateIndex
CREATE INDEX "ProviderHealthCheck_provider_createdAt_idx" ON "ProviderHealthCheck"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderHealthCheck_status_createdAt_idx" ON "ProviderHealthCheck"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderHealthCheck_provider_kind_createdAt_idx" ON "ProviderHealthCheck"("provider", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderDailyUsage_provider_date_idx" ON "ProviderDailyUsage"("provider", "date");

-- CreateIndex
CREATE INDEX "ProviderDailyUsage_date_idx" ON "ProviderDailyUsage"("date");

-- CreateIndex
CREATE INDEX "ProviderDailyUsage_source_date_idx" ON "ProviderDailyUsage"("source", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderDailyUsage_provider_modelId_source_date_key" ON "ProviderDailyUsage"("provider", "modelId", "source", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StripeWebhookEventLog_stripeEventId_key" ON "StripeWebhookEventLog"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeWebhookEventLog_status_receivedAt_idx" ON "StripeWebhookEventLog"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEventLog_eventType_receivedAt_idx" ON "StripeWebhookEventLog"("eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "AdminRetentionRun_mode_createdAt_idx" ON "AdminRetentionRun"("mode", "createdAt");

-- CreateIndex
CREATE INDEX "AdminRetentionRun_status_createdAt_idx" ON "AdminRetentionRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminOperationReport_status_createdAt_idx" ON "AdminOperationReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminOperationReport_createdById_createdAt_idx" ON "AdminOperationReport"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_jobKey_startedAt_idx" ON "ScheduledJobRun"("jobKey", "startedAt");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_jobKey_status_startedAt_idx" ON "ScheduledJobRun"("jobKey", "status", "startedAt");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_status_startedAt_idx" ON "ScheduledJobRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_jobKey_status_autoFixAttemptedAt_idx" ON "ScheduledJobRun"("jobKey", "status", "autoFixAttemptedAt");

-- CreateIndex
CREATE INDEX "AdminOperationalCheckpoint_status_nextDueAt_idx" ON "AdminOperationalCheckpoint"("status", "nextDueAt");

-- CreateIndex
CREATE INDEX "AdminOperationalCheckpoint_updatedAt_idx" ON "AdminOperationalCheckpoint"("updatedAt");

-- CreateIndex
CREATE INDEX "PrivacyRequest_status_dueAt_idx" ON "PrivacyRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "PrivacyRequest_userId_createdAt_idx" ON "PrivacyRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PrivacyRequest_email_createdAt_idx" ON "PrivacyRequest"("email", "createdAt");

-- CreateIndex
CREATE INDEX "PrivacyRequest_legalHold_dueAt_idx" ON "PrivacyRequest"("legalHold", "dueAt");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ConversationProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationProject" ADD CONSTRAINT "ConversationProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComparisonReview" ADD CONSTRAINT "ComparisonReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComparisonReview" ADD CONSTRAINT "ComparisonReview_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAnalyticsEvent" ADD CONSTRAINT "ProductAnalyticsEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPromotionRedemption" ADD CONSTRAINT "BillingPromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "BillingPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPromotionRedemption" ADD CONSTRAINT "BillingPromotionRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingTransaction" ADD CONSTRAINT "BillingTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "CreditPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_creditLotId_fkey" FOREIGN KEY ("creditLotId") REFERENCES "CreditLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "CreditPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditDebtEntry" ADD CONSTRAINT "CreditDebtEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditDebtEntry" ADD CONSTRAINT "CreditDebtEntry_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "CreditPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCreditReservation" ADD CONSTRAINT "ChatCreditReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequestTimelineEvent" ADD CONSTRAINT "RefundRequestTimelineEvent_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNote" ADD CONSTRAINT "AdminNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelOverride" ADD CONSTRAINT "ModelOverride_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- --------------------------------------------------------------------------
-- CHECK constraints
--
-- Not expressible in schema.prisma, so `migrate diff` cannot emit them and
-- `migrate diff` cannot see them drift either. Recovered from the archived
-- history and verified against it.
-- --------------------------------------------------------------------------

ALTER TABLE "ModelRegistryEntry"
  ADD CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check"
  CHECK (
  ("provider" = 'openai' AND "apiBaseUrl" = 'https://api.openai.com/v1' AND "apiKeyEnvName" = 'OPENAI_API_KEY') OR
  ("provider" = 'anthropic' AND "apiBaseUrl" = 'https://api.anthropic.com' AND "apiKeyEnvName" = 'ANTHROPIC_API_KEY') OR
  ("provider" = 'google' AND "apiBaseUrl" = 'https://generativelanguage.googleapis.com/v1beta' AND "apiKeyEnvName" = 'GOOGLE_GENERATIVE_AI_API_KEY') OR
  ("provider" = 'groq' AND "apiBaseUrl" = 'https://api.groq.com/openai/v1' AND "apiKeyEnvName" = 'GROQ_API_KEY') OR
  ("provider" = 'xai' AND "apiBaseUrl" = 'https://api.x.ai/v1' AND "apiKeyEnvName" = 'XAI_API_KEY') OR
  ("provider" = 'deepseek' AND "apiBaseUrl" = 'https://api.deepseek.com' AND "apiKeyEnvName" = 'DEEPSEEK_API_KEY') OR
  ("provider" = 'mistral' AND "apiBaseUrl" = 'https://api.mistral.ai/v1' AND "apiKeyEnvName" = 'MISTRAL_API_KEY') OR
  ("provider" = 'moonshot' AND "apiBaseUrl" = 'https://api.moonshot.ai/v1' AND "apiKeyEnvName" = 'MOONSHOT_API_KEY') OR
  ("provider" = 'qwen' AND "apiBaseUrl" = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' AND "apiKeyEnvName" = 'DASHSCOPE_API_KEY') OR
  ("provider" = 'zhipu' AND "apiBaseUrl" = 'https://api.z.ai/api/paas/v4' AND "apiKeyEnvName" = 'ZHIPU_API_KEY') OR
  ("provider" = 'perplexity' AND "apiBaseUrl" = 'https://api.perplexity.ai' AND "apiKeyEnvName" = 'PERPLEXITY_API_KEY') OR
  ("provider" NOT IN ('openai','anthropic','google','groq','xai','deepseek','mistral','moonshot','qwen','zhipu','perplexity') AND "apiBaseUrl" = 'https://invalid.invalid' AND "apiKeyEnvName" = 'DISABLED_MODEL_API_KEY' AND "enabled" = FALSE AND "publiclyListed" = FALSE));

ALTER TABLE "ProductAnalyticsEvent"
  ADD CONSTRAINT "ProductAnalyticsEvent_country_check"
  CHECK ("country" ~ '^[A-Z]{2}$');

ALTER TABLE "ProductAnalyticsEvent"
  ADD CONSTRAINT "ProductAnalyticsEvent_language_check"
  CHECK ("language" IN ('en', 'ko', 'zh', 'fr', 'de', 'es', 'pt'));

ALTER TABLE "ProductAnalyticsEvent"
  ADD CONSTRAINT "ProductAnalyticsEvent_modelCount_check"
  CHECK ("modelCount" BETWEEN 0 AND 3);

ALTER TABLE "ProductAnalyticsEvent"
  ADD CONSTRAINT "ProductAnalyticsEvent_name_check"
  CHECK ("eventName" IN (
  'landing_view',
  'cta_start_click',
  'pricing_view',
  'plan_selected',
  'chat_started',
  'first_response_completed',
  'multi_model_compare_completed',
  'comparison_review_viewed',
  'comparison_review_started',
  'comparison_review_completed',
  'comparison_review_failed',
  'followup_sent',
  'file_attached',
  'conversation_saved',
  'share_created',
  'signup_started',
  'signup_completed',
  'signup_page_view',
  'onboarding_shown',
  'onboarding_completed',
  'onboarding_skipped',
  'credit_limit_hit',
  'upgrade_prompt_view',
  'checkout_started',
  'checkout_failed',
  'purchase_completed',
  'promotion_pass_activated',
  'return_day_1',
  'return_day_7',
  'subscription_cancelled',
  'model_finder_viewed',
  'model_finder_started',
  'model_finder_completed',
  'model_finder_skipped',
  'recommended_model_accepted',
  'recommended_model_changed',
  'advanced_model_suggested',
  'advanced_model_selected',
  'help_opened',
  'help_article_viewed',
  'ui_help_opened',
  'sidebar_tour_started',
  'sidebar_tour_completed',
  'sidebar_tour_skipped',
  'chat_tool_menu_opened',
  'model_picker_opened',
  'model_picker_all_opened',
  'model_picker_search_used',
  'model_picker_filter_opened',
  'model_picker_filter_applied',
  'model_picker_selection_confirmed',
  'model_picker_max_reached',
  'model_picker_abandoned',
  'web_search_mode_selected',
  'web_search_suggestion_shown',
  'web_search_suggestion_accepted',
  'web_search_suggestion_declined',
  'deep_research_setup_opened',
  'deep_research_started',
  'deep_research_cancelled',
  'deep_research_completed',
  'deep_research_failed',
  'answer_sources_opened',
  'web_search_native_executed',
  'web_search_native_unsupported',
  'web_search_native_failed',
  'web_search_native_not_executed',
  'marketing_language_switched',
  'credit_pack_cta_view',
  'credit_pack_cta_click',
  'credit_pack_selected',
  'authentication_required',
  'purchase_intent_resumed',
  'checkout_cancelled'
));

ALTER TABLE "ProductAnalyticsEvent"
  ADD CONSTRAINT "ProductAnalyticsEvent_plan_check"
  CHECK ("plan" IN ('Guest', 'Free', 'Pro', 'Max'));

ALTER TABLE "ProductAnalyticsEvent"
  ADD CONSTRAINT "ProductAnalyticsEvent_source_check"
  CHECK ("source" IN ('client', 'server'));

ALTER TABLE "ProviderCreditConfig"
  ADD CONSTRAINT "ProviderCreditConfig_creditMicroUsd_nonnegative"
  CHECK ("creditMicroUsd" >= 0);

ALTER TABLE "ProviderCreditConfig"
  ADD CONSTRAINT "ProviderCreditConfig_usageBaselineMicroUsd_nonnegative"
  CHECK ("usageBaselineMicroUsd" >= 0);

ALTER TABLE "User"
  ADD CONSTRAINT "User_plan_check"
  CHECK ("plan" IN ('Free', 'Pro', 'Max'));

