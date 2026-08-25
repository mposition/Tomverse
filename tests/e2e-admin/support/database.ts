import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { staticModelRegistrySeedRows } from "../../../lib/modelRegistryShared";
import { userChatUsageKey } from "../../../lib/chatUsageKey";
import {
  ADMIN_E2E_IDENTITIES,
  ADMIN_E2E_IDENTITY_KEYS,
  adminE2eNextAuthSecret,
  resolveAdminE2EDatabaseUrl,
} from "./harness-config";
import {
  FIXTURE_ALERT_POLICY,
  FIXTURE_ANALYTICS,
  FIXTURE_APP_SETTINGS,
  FIXTURE_AUDIT_LOG,
  FIXTURE_CONVERSATION,
  FIXTURE_CREDIT,
  FIXTURE_CUSTOMERS,
  FIXTURE_FEEDBACK,
  FIXTURE_FIXED_AMOUNT_PROMOTION,
  FIXTURE_TRACE_REPORT,
  FIXTURE_HEALTH_CHECK,
  FIXTURE_INCIDENT,
  FIXTURE_JOB_RUN,
  FIXTURE_MODEL,
  FIXTURE_NOTIFICATION,
  FIXTURE_PRIVACY_REQUEST,
  FIXTURE_PROMOTION,
  FIXTURE_PROVIDER_USAGE,
  FIXTURE_REFUNDS,
  FIXTURE_RETENTION_RUN,
  FIXTURE_SUPPRESSION,
  FIXTURE_USAGE,
  FIXTURE_WEBHOOK,
} from "./fixture-data";
import { EMAIL_CAMPAIGNS_FLAG_KEY } from "@/lib/emailFeatureFlags";

/**
 * The fixture boundary for the Admin Console E2E suite.
 *
 * The suite drives the real admin routes against a real PostgreSQL database,
 * so "fixtures" here means rows, not stubs: nothing in the application is
 * replaced or short-circuited. `resetAdminDatabase()` truncates every table and
 * `seedAdminFixtures()` writes the same dataset back, which is what makes the
 * specs order-independent -- each one starts from byte-identical state.
 *
 * The connection string is validated by `resolveAdminE2EDatabaseUrl()` before
 * anything is truncated.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let client: PrismaClient | null = null;
let pool: Pool | null = null;

export const adminFixtureDatabase = () => {
  if (!client) {
    const connectionString = resolveAdminE2EDatabaseUrl();
    pool = new Pool({ connectionString });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  return client;
};

export const disconnectAdminFixtureDatabase = async () => {
  await client?.$disconnect();
  await pool?.end();
  client = null;
  pool = null;
};

/**
 * Truncates every application table.
 *
 * Discovered from `information_schema` rather than listed by hand, so a new
 * Prisma model cannot silently start leaking state between tests. `CASCADE`
 * makes the order irrelevant; `_prisma_migrations` is left alone because
 * dropping it would make the schema look unmigrated.
 */
export const resetAdminDatabase = async () => {
  const prisma = adminFixtureDatabase();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) {
    throw new Error(
      "The admin E2E database has no tables. Run `npm run test:e2e:admin`, which pushes the Prisma schema before starting Playwright."
    );
  }
  const list = tables.map((row) => `"public"."${row.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`
  );
};

const iso = (offsetMs: number, from: number) => new Date(from + offsetMs);

/**
 * Writes the deterministic dataset described in `fixture-data.ts`.
 *
 * Returns the seed instant so a spec that needs to reason about relative ages
 * can do so without reading the clock a second time.
 */
export const seedAdminFixtures = async () => {
  const prisma = adminFixtureDatabase();
  const now = Date.now();
  const at = (offsetMs: number) => iso(offsetMs, now);

  // --- Administrators and customers -------------------------------------
  // The administrators are ordinary user rows. They are administrators only
  // because ADMIN_EMAILS / ADMIN_<ROLE>_EMAILS name them; nothing here grants
  // a privilege.
  await prisma.user.createMany({
    data: ADMIN_E2E_IDENTITY_KEYS.map((key) => {
      const admin = ADMIN_E2E_IDENTITIES[key];
      return {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        plan: "Free",
        lastLoginAt: at(-2 * HOUR),
        createdAt: at(-90 * DAY),
      };
    }),
  });

  await prisma.user.createMany({
    data: [
      {
        id: FIXTURE_CUSTOMERS.activePro.id,
        email: FIXTURE_CUSTOMERS.activePro.email,
        name: FIXTURE_CUSTOMERS.activePro.name,
        plan: FIXTURE_CUSTOMERS.activePro.plan,
        stripeCustomerId: "cus_e2e_active_pro",
        stripeSubscriptionId: "sub_e2e_active_pro",
        stripePriceId: "price_e2e_pro_monthly",
        subscriptionStatus: "active",
        subscriptionBillingInterval: "monthly",
        subscriptionCurrentPeriodEnd: at(21 * DAY),
        lastLoginAt: at(-3 * HOUR),
        createdAt: at(-60 * DAY),
      },
      {
        id: FIXTURE_CUSTOMERS.pendingDeletion.id,
        email: FIXTURE_CUSTOMERS.pendingDeletion.email,
        name: FIXTURE_CUSTOMERS.pendingDeletion.name,
        plan: FIXTURE_CUSTOMERS.pendingDeletion.plan,
        accountStatus: "pending_deletion",
        accountDeletionRequestedAt: at(-5 * DAY),
        accountDeletionScheduledFor: at(25 * DAY),
        aiUsageRestricted: true,
        aiUsageRestrictionReason: "Deletion requested by the customer",
        lastLoginAt: at(-5 * DAY),
        createdAt: at(-200 * DAY),
      },
      {
        id: FIXTURE_CUSTOMERS.suspended.id,
        email: FIXTURE_CUSTOMERS.suspended.email,
        name: FIXTURE_CUSTOMERS.suspended.name,
        plan: FIXTURE_CUSTOMERS.suspended.plan,
        accountStatus: "suspended",
        accountSuspendedAt: at(-2 * DAY),
        accountSuspendedUntil: at(12 * DAY),
        accountSuspensionReason: "Confirmed payment fraud",
        lastLoginAt: at(-2 * DAY),
        createdAt: at(-120 * DAY),
      },
      {
        id: FIXTURE_CUSTOMERS.disputedHold.id,
        email: FIXTURE_CUSTOMERS.disputedHold.email,
        name: FIXTURE_CUSTOMERS.disputedHold.name,
        plan: FIXTURE_CUSTOMERS.disputedHold.plan,
        stripeCustomerId: "cus_e2e_disputed",
        subscriptionStatus: "active",
        subscriptionBillingInterval: "monthly",
        subscriptionCurrentPeriodEnd: at(9 * DAY),
        subscriptionCancelAtPeriodEnd: true,
        creditDebtCredits: 640,
        creditDebtCostMicroUsd: BigInt(1_920_000),
        billingRiskStatus: "disputed_hold",
        billingRiskReason: "Chargeback opened on the Power credit pack",
        billingRiskAt: at(-1 * DAY),
        lastLoginAt: at(-1 * DAY),
        createdAt: at(-45 * DAY),
      },
    ],
  });

  await prisma.account.create({
    data: {
      id: "e2e-account-active-pro-google",
      userId: FIXTURE_CUSTOMERS.activePro.id,
      type: "oauth",
      provider: "google",
      providerAccountId: "e2e-google-active-pro",
    },
  });

  await prisma.userSettings.create({
    data: {
      userId: FIXTURE_CUSTOMERS.activePro.id,
      language: "en",
      theme: "dark",
      defaultModel: FIXTURE_MODEL.enabled.id,
    },
  });

  // --- Conversations and usage ------------------------------------------
  await prisma.conversation.create({
    data: {
      id: FIXTURE_CONVERSATION.id,
      userId: FIXTURE_CUSTOMERS.activePro.id,
      title: FIXTURE_CONVERSATION.title,
      updatedAt: at(-4 * HOUR),
      messages: {
        create: [
          {
            id: "e2e-message-user",
            role: "user",
            content: "Compare the two models on this brief.",
          },
          {
            id: "e2e-message-assistant",
            role: "assistant",
            content: "Here is the comparison.",
            modelId: FIXTURE_MODEL.enabled.id,
          },
        ],
      },
    },
  });

  const utcDayStart = new Date(
    Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate()
    )
  );
  const utcMonthStart = new Date(
    Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
  );
  // The key the application derives, not the raw user id. Seeding `user:<id>`
  // meant the admin routes -- which look the rows up by
  // `getUserChatUsageKey()` -- never found them, so every usage figure in this
  // suite read zero and the specs stayed green through a serialization failure
  // that only fires once a bucket exists.
  const usageKey = userChatUsageKey(
    FIXTURE_CUSTOMERS.activePro.id,
    adminE2eNextAuthSecret()
  );
  await prisma.chatUsageBucket.createMany({
    data: [
      {
        key: usageKey,
        period: "day",
        periodStart: utcDayStart,
        count: BigInt(FIXTURE_USAGE.creditsToday),
      },
      {
        key: usageKey,
        period: "month",
        periodStart: utcMonthStart,
        count: BigInt(FIXTURE_USAGE.creditsMonth),
      },
    ],
  });

  // --- Support surfaces --------------------------------------------------
  // The verified trace evidence exists before the feedback rows so the open
  // report can reference it by plain FK inside createMany.
  await prisma.traceErrorEvidence.create({
    data: {
      id: FIXTURE_TRACE_REPORT.verified.evidenceId,
      occurrenceId: FIXTURE_TRACE_REPORT.verified.occurrenceId,
      traceId: FIXTURE_TRACE_REPORT.verified.traceId,
      traceProvenance: "server_generated",
      environment: "e2e",
      release: FIXTURE_TRACE_REPORT.verified.release,
      routeClass: FIXTURE_TRACE_REPORT.verified.routeClass,
      phase: "request",
      errorCode: FIXTURE_TRACE_REPORT.verified.errorCode,
      classificationSource: "server",
      httpStatus: 500,
      provider: "openai",
      modelId: "gpt-5-6-luna",
      retryable: false,
      occurredAt: at(-2 * HOUR),
    },
  });
  await prisma.feedback.createMany({
    data: [
      {
        id: FIXTURE_FEEDBACK.open.id,
        userId: FIXTURE_CUSTOMERS.activePro.id,
        email: FIXTURE_CUSTOMERS.activePro.email,
        type: FIXTURE_FEEDBACK.open.type,
        status: "open",
        message: FIXTURE_FEEDBACK.open.message,
        plan: "Pro",
        // Opted into lifecycle status emails, so the console journeys can
        // exercise the notify badge and the completion dialog's email path.
        emailUpdatesConsent: true,
        language: "en",
        createdAt: at(-2 * HOUR),
        // The fully verified trace path: signed token verified, evidence
        // recorded and exactly linked, server-classified code.
        traceId: FIXTURE_TRACE_REPORT.verified.traceId,
        errorReportVerification: "verified",
        traceProvenance: "server_generated",
        errorClassificationSource: "server",
        evidenceAvailability: "recorded",
        traceEvidenceId: FIXTURE_TRACE_REPORT.verified.evidenceId,
      },
      {
        id: FIXTURE_FEEDBACK.slaBreached.id,
        userId: FIXTURE_CUSTOMERS.disputedHold.id,
        email: FIXTURE_CUSTOMERS.disputedHold.email,
        type: FIXTURE_FEEDBACK.slaBreached.type,
        status: "open",
        message: FIXTURE_FEEDBACK.slaBreached.message,
        plan: "Max",
        createdAt: at(-FIXTURE_FEEDBACK.slaBreached.ageHours * HOUR),
        // The honest opposite: a client-classified empty response with no
        // token -- unverified by design.
        traceId: FIXTURE_TRACE_REPORT.clientClassified.traceId,
        errorReportVerification: "missing_token",
        traceProvenance: "server_generated",
        errorClassificationSource: "client",
        clientErrorCode: "EMPTY_RESPONSE",
      },
      {
        id: FIXTURE_FEEDBACK.resolved.id,
        email: FIXTURE_CUSTOMERS.suspended.email,
        type: FIXTURE_FEEDBACK.resolved.type,
        status: "resolved",
        message: FIXTURE_FEEDBACK.resolved.message,
        plan: "Free",
        createdAt: at(-6 * DAY),
      },
    ],
  });

  // Phase 2 shadow diagnosis for the verified report: a candidate waiting on
  // a human, exactly as the worker leaves it. Observational only -- the panel
  // must label it as such.
  await prisma.feedbackAutoFixCase.create({
    data: {
      id: FIXTURE_TRACE_REPORT.verified.caseId,
      feedbackId: FIXTURE_FEEDBACK.open.id,
      traceId: FIXTURE_TRACE_REPORT.verified.traceId,
      occurrenceId: FIXTURE_TRACE_REPORT.verified.occurrenceId,
      fingerprint: `${FIXTURE_TRACE_REPORT.verified.errorCode}|${FIXTURE_TRACE_REPORT.verified.release}`,
      sourceRelease: FIXTURE_TRACE_REPORT.verified.release,
      state: "awaiting_human_review",
      classification: "application_candidate",
      attemptCount: 1,
      diagnosticSummary: {
        classification: "application_candidate",
        errorCode: FIXTURE_TRACE_REPORT.verified.errorCode,
        routeClass: FIXTURE_TRACE_REPORT.verified.routeClass,
      },
    },
  });

  await prisma.privacyRequest.create({
    data: {
      id: FIXTURE_PRIVACY_REQUEST.open.id,
      userId: FIXTURE_CUSTOMERS.activePro.id,
      email: FIXTURE_PRIVACY_REQUEST.open.email,
      requestType: FIXTURE_PRIVACY_REQUEST.open.requestType,
      status: "open",
      dueAt: at(10 * DAY),
      createdAt: at(-2 * DAY),
    },
  });

  // --- Billing surfaces --------------------------------------------------
  await prisma.refundRequest.create({
    data: {
      id: FIXTURE_REFUNDS.pending.id,
      userId: FIXTURE_CUSTOMERS.activePro.id,
      email: FIXTURE_REFUNDS.pending.email,
      plan: FIXTURE_REFUNDS.pending.plan,
      status: "pending",
      reason: FIXTURE_REFUNDS.pending.reason,
      stripeCustomerId: "cus_e2e_active_pro",
      stripeSubscriptionId: "sub_e2e_active_pro",
      subscriptionStatus: "active",
      subscriptionBillingInterval: "monthly",
      subscriptionCurrentPeriodEnd: at(21 * DAY),
      refundAmountCents: FIXTURE_REFUNDS.pending.refundAmountCents,
      refundCurrency: "usd",
      requestedAt: at(-6 * HOUR),
      timelineEvents: {
        create: [
          {
            id: "e2e-refund-pending-timeline",
            eventType: "requested",
            message: "Customer submitted a refund request from the billing page.",
            createdAt: at(-6 * HOUR),
          },
        ],
      },
    },
  });

  await prisma.refundRequest.create({
    data: {
      id: FIXTURE_REFUNDS.approved.id,
      userId: FIXTURE_CUSTOMERS.disputedHold.id,
      email: FIXTURE_REFUNDS.approved.email,
      plan: FIXTURE_REFUNDS.approved.plan,
      status: "approved",
      reason: FIXTURE_REFUNDS.approved.reason,
      adminNote: "Approved after verifying the duplicate charge.",
      refundAmountCents: FIXTURE_REFUNDS.approved.refundAmountCents,
      refundCurrency: "usd",
      requestedAt: at(-4 * DAY),
      reviewedAt: at(-3 * DAY),
    },
  });

  await prisma.creditPurchase.create({
    data: {
      id: FIXTURE_CREDIT.purchaseId,
      userId: FIXTURE_CUSTOMERS.activePro.id,
      packId: FIXTURE_CREDIT.packId,
      stripeCheckoutSessionId: "cs_e2e_credit_purchase",
      stripePaymentIntentId: "pi_e2e_credit_purchase",
      stripeChargeId: "ch_e2e_credit_purchase",
      creditsPurchased: FIXTURE_CREDIT.creditsPurchased,
      fundedCostMicroUsd: BigInt(9_990_000),
      amountPaidCents: 999,
      amountPaidUsdMicroUsd: BigInt(9_990_000),
      purchasedAt: at(-10 * DAY),
      expiresAt: at(355 * DAY),
      lots: {
        create: [
          {
            id: FIXTURE_CREDIT.lotId,
            userId: FIXTURE_CUSTOMERS.activePro.id,
            source: "purchase",
            originalCredits: FIXTURE_CREDIT.creditsPurchased,
            remainingCredits: 1_180,
            originalFundedCostMicroUsd: BigInt(9_990_000),
            remainingFundedCostMicroUsd: BigInt(7_858_800),
            expiresAt: at(355 * DAY),
          },
        ],
      },
    },
  });

  await prisma.creditLedgerEntry.createMany({
    data: [
      {
        id: FIXTURE_CREDIT.ledgerEntryId,
        userId: FIXTURE_CUSTOMERS.activePro.id,
        creditLotId: FIXTURE_CREDIT.lotId,
        purchaseId: FIXTURE_CREDIT.purchaseId,
        type: "purchase_grant",
        creditsDelta: FIXTURE_CREDIT.creditsPurchased,
        fundedCostMicroUsdDelta: BigInt(9_990_000),
        balanceAfterCredits: FIXTURE_CREDIT.creditsPurchased,
        balanceAfterFundedCostMicroUsd: BigInt(9_990_000),
        createdAt: at(-10 * DAY),
      },
      {
        id: "e2e-credit-ledger-settle",
        userId: FIXTURE_CUSTOMERS.activePro.id,
        creditLotId: FIXTURE_CREDIT.lotId,
        purchaseId: FIXTURE_CREDIT.purchaseId,
        type: "settlement",
        creditsDelta: -320,
        fundedCostMicroUsdDelta: BigInt(-2_131_200),
        balanceAfterCredits: 1_180,
        balanceAfterFundedCostMicroUsd: BigInt(7_858_800),
        createdAt: at(-2 * DAY),
      },
    ],
  });

  await prisma.billingPromotion.create({
    data: {
      id: FIXTURE_PROMOTION.id,
      code: FIXTURE_PROMOTION.code,
      discountPercent: FIXTURE_PROMOTION.discountPercent,
      durationMonths: 3,
      maxRedemptions: FIXTURE_PROMOTION.maxRedemptions,
      redeemedCount: 9,
      appliesToPlanIds: JSON.stringify(["pro"]),
      isActive: true,
      // An active promotion is only valid with both a redemption cap and an
      // end date (`promotionSchema` in app/api/admin/billing/route.ts), so the
      // seeded code has to satisfy that or every save would be refused for the
      // wrong reason.
      startsAt: at(-30 * DAY),
      endsAt: at(90 * DAY),
      redemptions: {
        create: [
          {
            id: "e2e-promotion-redemption",
            userId: FIXTURE_CUSTOMERS.disputedHold.id,
            planId: "pro",
            billingInterval: "monthly",
            riskFlags: JSON.stringify(["shared_ip", "shared_payment_method"]),
            redeemedAt: at(-3 * DAY),
          },
        ],
      },
    },
  });

  await prisma.billingPromotion.create({
    data: {
      id: FIXTURE_FIXED_AMOUNT_PROMOTION.id,
      code: FIXTURE_FIXED_AMOUNT_PROMOTION.code,
      discountPercent: 0,
      discountAmountCents: FIXTURE_FIXED_AMOUNT_PROMOTION.discountAmountCents,
      durationMonths: 1,
      maxRedemptions: 100,
      redeemedCount: 2,
      appliesToPlanIds: JSON.stringify(["pro"]),
      // Paused, and it has to stay refusable to restart: reactivating a
      // fixed-amount code is the row of section 4's matrix that the console is
      // most likely to be asked for.
      isActive: false,
      startsAt: at(-60 * DAY),
      endsAt: at(30 * DAY),
    },
  });

  await prisma.stripeWebhookEventLog.createMany({
    data: [
      {
        id: FIXTURE_WEBHOOK.failed.id,
        stripeEventId: FIXTURE_WEBHOOK.failed.stripeEventId,
        eventType: FIXTURE_WEBHOOK.failed.eventType,
        status: "failed",
        error: "E2E seeded delivery failure",
        receivedAt: at(-3 * HOUR),
      },
      {
        id: FIXTURE_WEBHOOK.processed.id,
        stripeEventId: FIXTURE_WEBHOOK.processed.stripeEventId,
        eventType: FIXTURE_WEBHOOK.processed.eventType,
        status: "processed",
        receivedAt: at(-2 * DAY),
        processedAt: at(-2 * DAY),
      },
    ],
  });

  // --- AI platform surfaces ---------------------------------------------
  // The application bootstraps `ModelRegistryEntry` from `lib/models.ts` once
  // per server process and memoises that promise, so it would never refill the
  // table after a truncation -- every later test would see an empty catalogue,
  // an empty model picker and an empty guest-default selector. The fixture
  // therefore writes the same static catalogue itself, from the single shared
  // definition the runtime bootstrap uses.
  await prisma.modelRegistryEntry.createMany({
    data: staticModelRegistrySeedRows(),
    skipDuplicates: true,
  });
  await prisma.modelRegistryEntry.createMany({
    data: [
      {
        id: FIXTURE_MODEL.enabled.id,
        name: FIXTURE_MODEL.enabled.name,
        apiModel: FIXTURE_MODEL.enabled.apiModel,
        provider: FIXTURE_MODEL.enabled.provider,
        apiBaseUrl: FIXTURE_MODEL.enabled.apiBaseUrl,
        apiKeyEnvName: "OPENAI_API_KEY",
        bestFor: "Deterministic E2E coverage",
        minimumPlan: "Free",
        usageClass: "standard",
        creditWeight: 1,
        status: "enabled",
        enabled: true,
        sortOrder: 1,
      },
      {
        id: FIXTURE_MODEL.disabled.id,
        name: FIXTURE_MODEL.disabled.name,
        apiModel: FIXTURE_MODEL.disabled.apiModel,
        provider: FIXTURE_MODEL.disabled.provider,
        apiBaseUrl: FIXTURE_MODEL.disabled.apiBaseUrl,
        apiKeyEnvName: "ANTHROPIC_API_KEY",
        bestFor: "Disabled-state coverage",
        minimumPlan: "Pro",
        usageClass: "premium",
        creditWeight: 5,
        status: "disabled",
        operationalReason: "Seeded as disabled for admin E2E coverage",
        enabled: false,
        sortOrder: 2,
      },
      {
        id: FIXTURE_MODEL.retired.id,
        name: FIXTURE_MODEL.retired.name,
        apiModel: FIXTURE_MODEL.retired.apiModel,
        provider: FIXTURE_MODEL.retired.provider,
        apiBaseUrl: FIXTURE_MODEL.retired.apiBaseUrl,
        apiKeyEnvName: "GOOGLE_GENERATIVE_AI_API_KEY",
        bestFor: "Retired-state coverage",
        minimumPlan: "Free",
        usageClass: "standard",
        creditWeight: 1,
        // The exact shape `isRetiredModel()` recognises: delisted, disabled
        // and status disabled. The disabled fixture above deliberately keeps
        // publiclyListed at its default so the two stay distinguishable.
        status: "disabled",
        publiclyListed: false,
        enabled: false,
        operationalReason: "Seeded as retired for admin E2E coverage",
        sortOrder: 3,
      },
      {
        id: FIXTURE_MODEL.archived.id,
        name: FIXTURE_MODEL.archived.name,
        apiModel: FIXTURE_MODEL.archived.apiModel,
        provider: FIXTURE_MODEL.archived.provider,
        apiBaseUrl: FIXTURE_MODEL.archived.apiBaseUrl,
        apiKeyEnvName: "OPENAI_API_KEY",
        bestFor: "Archived-state coverage",
        minimumPlan: "Free",
        usageClass: "standard",
        creditWeight: 1,
        // Removed from the catalogue while otherwise runnable, so "archived"
        // cannot be mistaken for "retired" or "disabled".
        status: "enabled",
        enabled: true,
        catalogDeleted: true,
        operationalReason: "Seeded as archived for admin E2E coverage",
        sortOrder: 4,
      },
    ],
  });

  await prisma.adminProviderIncident.createMany({
    data: [
      {
        id: FIXTURE_INCIDENT.active.id,
        provider: FIXTURE_INCIDENT.active.provider,
        status: FIXTURE_INCIDENT.active.status,
        title: FIXTURE_INCIDENT.active.title,
        message: "Upstream latency above the alerting threshold.",
        createdByEmail: ADMIN_E2E_IDENTITIES.ops.email,
        startsAt: at(-90 * MINUTE),
        createdAt: at(-90 * MINUTE),
      },
      {
        id: FIXTURE_INCIDENT.resolved.id,
        provider: FIXTURE_INCIDENT.resolved.provider,
        status: FIXTURE_INCIDENT.resolved.status,
        title: FIXTURE_INCIDENT.resolved.title,
        message: "Recovered after the provider restored capacity.",
        createdByEmail: ADMIN_E2E_IDENTITIES.ops.email,
        resolvedByEmail: ADMIN_E2E_IDENTITIES.owner.email,
        startsAt: at(-2 * DAY),
        resolvedAt: at(-1 * DAY),
        createdAt: at(-2 * DAY),
      },
    ],
  });

  await prisma.providerHealthCheck.create({
    data: {
      id: FIXTURE_HEALTH_CHECK.id,
      provider: FIXTURE_HEALTH_CHECK.provider,
      modelId: FIXTURE_MODEL.enabled.id,
      status: FIXTURE_HEALTH_CHECK.status,
      latencyMs: 4_120,
      errorCode: FIXTURE_HEALTH_CHECK.errorCode,
      message: "Probe exceeded the latency budget.",
      createdByEmail: ADMIN_E2E_IDENTITIES.ops.email,
      createdAt: at(-30 * MINUTE),
    },
  });

  await prisma.providerDailyUsage.create({
    data: {
      provider: FIXTURE_PROVIDER_USAGE.provider,
      date: utcDayStart,
      requestCount: 128,
      inputTokens: 412_000,
      outputTokens: 98_000,
      estimatedCostMicroUsd: FIXTURE_PROVIDER_USAGE.estimatedCostMicroUsd,
    },
  });

  // --- Operations surfaces ----------------------------------------------
  await prisma.appSetting.createMany({
    data: [
      {
        key: "guestDefaultModelId",
        value: FIXTURE_APP_SETTINGS.guestDefaultModelId,
      },
      // The campaign console lives behind this (EM-05, ADR section 15.2) and it
      // is off everywhere it has not been switched on. The harness switches it
      // on so the console's own specs exercise the feature; one spec turns it
      // back off to check what an operator sees when it is not.
      { key: EMAIL_CAMPAIGNS_FLAG_KEY, value: "true" },
    ],
  });

  await prisma.suppressionEntry.create({
    data: {
      emailAddress: FIXTURE_SUPPRESSION.emailAddress,
      scope: FIXTURE_SUPPRESSION.scope,
      purposeKey: FIXTURE_SUPPRESSION.purposeKey,
      reason: FIXTURE_SUPPRESSION.reason,
      source: FIXTURE_SUPPRESSION.source,
    },
  });

  await prisma.adminAlertPolicy.create({
    data: {
      id: FIXTURE_ALERT_POLICY.id,
      name: FIXTURE_ALERT_POLICY.name,
      isActive: true,
      notifyEmail: true,
    },
  });

  await prisma.adminNotificationLog.create({
    data: {
      id: FIXTURE_NOTIFICATION.failed.id,
      channel: "slack",
      title: FIXTURE_NOTIFICATION.failed.title,
      detail: FIXTURE_NOTIFICATION.failed.detail,
      status: "failed",
      createdAt: at(-45 * MINUTE),
    },
  });

  await prisma.scheduledJobRun.createMany({
    data: [
      {
        id: FIXTURE_JOB_RUN.succeeded.id,
        jobKey: FIXTURE_JOB_RUN.succeeded.jobKey,
        status: "succeeded",
        processedCount: 42,
        startedAt: at(-3 * HOUR),
        completedAt: at(-3 * HOUR + MINUTE),
      },
      {
        id: FIXTURE_JOB_RUN.failed.id,
        jobKey: FIXTURE_JOB_RUN.failed.jobKey,
        status: "failed",
        error: FIXTURE_JOB_RUN.failed.error,
        startedAt: at(-26 * HOUR),
        completedAt: at(-26 * HOUR + MINUTE),
      },
    ],
  });

  await prisma.adminRetentionRun.create({
    data: {
      id: FIXTURE_RETENTION_RUN.id,
      mode: FIXTURE_RETENTION_RUN.mode,
      status: "succeeded",
      createdByEmail: ADMIN_E2E_IDENTITIES.ops.email,
      createdAt: at(-1 * DAY),
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      id: FIXTURE_AUDIT_LOG.id,
      actorUserId: ADMIN_E2E_IDENTITIES.owner.id,
      actorEmail: ADMIN_E2E_IDENTITIES.owner.email,
      action: FIXTURE_AUDIT_LOG.action,
      targetType: "AppSetting",
      targetId: "guestDefaultModelId",
      summary: FIXTURE_AUDIT_LOG.summary,
      createdAt: at(-20 * MINUTE),
    },
  });

  await prisma.productAnalyticsEvent.createMany({
    data: Array.from({ length: FIXTURE_ANALYTICS.count }, (_, index) => ({
      id: `e2e-analytics-${index}`,
      dedupeKey: `e2e-analytics-dedupe-${index}`,
      eventName: FIXTURE_ANALYTICS.eventName,
      source: "server",
      userId: FIXTURE_CUSTOMERS.activePro.id,
      anonymousIdHash: `e2e-anon-${index}`,
      sessionIdHash: `e2e-session-${index}`,
      utmSource: "e2e",
      utmMedium: "qa",
      utmCampaign: FIXTURE_ANALYTICS.utmCampaign,
      language: "en",
      country: "US",
      modelCount: 2,
      plan: "Pro",
      occurredAt: at(-(index + 1) * HOUR),
    })),
  });

  return { seededAt: new Date(now) };
};

/** Truncate plus seed, i.e. the state every admin spec starts from. */
export const resetAndSeedAdminFixtures = async () => {
  await resetAdminDatabase();
  return seedAdminFixtures();
};

/**
 * Writes an `AppSetting` row directly, for a spec that needs a flag in a state
 * the harness does not seed.
 *
 * Test infrastructure, not a product path. The email feature flags are
 * deliberately not writable through any admin API
 * (docs/policy/email-notifications.md §15.2, registered in
 * `tests/appSettingWriters.test.mjs`), so a spec about one of them being off
 * cannot get there by driving the console — and hiding that by adding a writer
 * for the test's convenience would remove the very decision the ADR made.
 */
export const setAppSettingDirectly = async (key: string, value: string) => {
  const prisma = adminFixtureDatabase();
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
};
