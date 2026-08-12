/**
 * Deployment configuration the Admin Console reports on.
 *
 * Extracted from the old monolithic workspace so the Overview page can own it
 * and no other route pays to compute it. Reads only presence and shape --
 * never a value -- so nothing here can leak a secret into a rendered page.
 */

export type AdminEnvCheck = {
  name: string;
  configured: boolean;
  description: string;
};

const isConfigured = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

const isStrongSecret = (value: string | undefined) =>
  typeof value === "string" && value.trim().length >= 32;

const isGa4MeasurementId = (value: string | undefined) =>
  typeof value === "string" && /^G-[A-Z0-9]+$/.test(value.trim());

export function adminEnvironmentChecks(): AdminEnvCheck[] {
  const azureOAuthRequested =
    isConfigured(process.env.AZURE_AD_CLIENT_ID) ||
    isConfigured(process.env.AZURE_AD_CLIENT_SECRET) ||
    isConfigured(process.env.AZURE_AD_TENANT_ID);
  const azureOAuthConfigurationComplete =
    !azureOAuthRequested ||
    (isConfigured(process.env.AZURE_AD_CLIENT_ID) &&
      isConfigured(process.env.AZURE_AD_CLIENT_SECRET) &&
      isConfigured(process.env.AZURE_AD_TENANT_ID));

  return [
    {
      name: "NEXTAUTH_SECRET",
      configured: isStrongSecret(process.env.NEXTAUTH_SECRET),
      description: "Requires a stable, high-entropy value of at least 32 characters.",
    },
    {
      name: "OAUTH_TOKEN_ENCRYPTION_KEY",
      configured: isStrongSecret(process.env.OAUTH_TOKEN_ENCRYPTION_KEY),
      description: "Dedicated 32+ character key required for OAuth token encryption.",
    },
    {
      name: "AZURE_AD_*",
      configured: azureOAuthConfigurationComplete,
      description:
        "Client ID, client secret, and tenant ID must be configured together; common is supported for public sign-in.",
    },
    {
      name: "MAINTENANCE_SECRET",
      configured: isStrongSecret(process.env.MAINTENANCE_SECRET),
      description:
        "Protects the scheduled cleanup endpoint and must be at least 32 characters.",
    },
    {
      name: "ADMIN_EMAILS",
      configured: isConfigured(process.env.ADMIN_EMAILS),
      description: "Controls who can access this console.",
    },
    {
      name: "STRIPE_SECRET_KEY",
      configured: isConfigured(process.env.STRIPE_SECRET_KEY),
      description: "Required for checkout, refunds, and subscription cancellation.",
    },
    {
      name: "STRIPE_WEBHOOK_SECRET",
      configured: isConfigured(process.env.STRIPE_WEBHOOK_SECRET),
      description: "Required to trust Stripe billing events.",
    },
    {
      name: "GA4_MEASUREMENT_ID",
      configured: isGa4MeasurementId(process.env.GA4_MEASUREMENT_ID),
      description:
        "Public GA4 web data-stream identifier used after analytics consent.",
    },
    {
      name: "GA4_API_SECRET",
      configured: isConfigured(process.env.GA4_API_SECRET),
      description:
        "Server-only Measurement Protocol secret for purchase and cancellation events.",
    },
    {
      name: "RAILWAY_USAGE_API",
      configured:
        (isConfigured(process.env.RAILWAY_PROJECT_ID) &&
          (isConfigured(process.env.RAILWAY_PROJECT_TOKEN) ||
            isConfigured(process.env.RAILWAY_API_TOKEN))) ||
        (isConfigured(process.env.RAILWAY_WORKSPACE_ID) &&
          isConfigured(process.env.RAILWAY_API_TOKEN)),
      description:
        "Railway project ID plus project/account token, or workspace ID plus workspace/account token.",
    },
    {
      name: "PRISMA_USAGE_API",
      configured:
        isConfigured(process.env.PRISMA_MANAGEMENT_API_TOKEN) &&
        isConfigured(process.env.PRISMA_DATABASE_ID),
      description:
        "Prisma service token and database ID used for monthly operations monitoring.",
    },
    {
      name: "RESEND_API_KEY",
      configured: isConfigured(process.env.RESEND_API_KEY),
      description: "Required for Tomverse transactional email.",
    },
    {
      name: "SUPPORT_NOTIFICATION_EMAIL",
      configured:
        isConfigured(process.env.SUPPORT_NOTIFICATION_EMAIL) ||
        isConfigured(process.env.ADMIN_ALERT_EMAIL) ||
        isConfigured(process.env.ADMIN_EMAILS),
      description:
        "Receives website support form notifications. Falls back to ADMIN_ALERT_EMAIL or ADMIN_EMAILS.",
    },
    {
      name: "TRANSACTIONAL_EMAIL_FROM",
      configured: true,
      description:
        "Verified sender used for account and billing emails. Defaults to hello@tomverse.app.",
    },
    {
      name: "SLACK_WEBHOOK_URL",
      configured: isConfigured(process.env.SLACK_WEBHOOK_URL),
      description: "Optional incident notification channel.",
    },
    {
      name: "PROVIDER_USAGE_SLACK_WEBHOOK_URL",
      configured:
        isConfigured(process.env.PROVIDER_USAGE_SLACK_WEBHOOK_URL) ||
        isConfigured(process.env.SLACK_WEBHOOK_URL),
      description:
        "Daily provider usage and estimated-balance report channel. Falls back to SLACK_WEBHOOK_URL.",
    },
    {
      name: "DISCORD_WEBHOOK_URL",
      configured: isConfigured(process.env.DISCORD_WEBHOOK_URL),
      description: "Optional secondary incident notification channel.",
    },
    {
      name: "SENTRY_DSN",
      configured: isConfigured(process.env.SENTRY_DSN),
      description:
        "DB-independent server error retention for outages that cannot be written to Prisma.",
    },
    {
      name: "OPS_ALERT_CHANNEL",
      configured:
        isConfigured(process.env.OPS_ALERT_SLACK_WEBHOOK_URL) ||
        isConfigured(process.env.SLACK_WEBHOOK_URL) ||
        isConfigured(process.env.OPS_ALERT_DISCORD_WEBHOOK_URL) ||
        isConfigured(process.env.DISCORD_WEBHOOK_URL) ||
        (isConfigured(process.env.RESEND_API_KEY) &&
          (isConfigured(process.env.OPS_ALERT_EMAIL) ||
            isConfigured(process.env.ADMIN_ALERT_EMAIL))),
      description:
        "At least one DB-independent Slack, Discord, or email incident channel.",
    },
  ];
}

/**
 * A single 0-100 readiness reading.
 *
 * The weights are the ones the console has always used; only their home moved.
 */
export const adminHealthScore = ({
  outageCount,
  limitedCount,
  pendingRefundCount,
  openFeedbackCount,
  missingEnvCount,
  alertFailureCount,
}: {
  outageCount: number;
  limitedCount: number;
  pendingRefundCount: number;
  openFeedbackCount: number;
  missingEnvCount: number;
  alertFailureCount: number;
}) =>
  Math.max(
    0,
    Math.min(
      100,
      100 -
        outageCount * 18 -
        limitedCount * 8 -
        pendingRefundCount * 3 -
        openFeedbackCount * 2 -
        missingEnvCount * 10 -
        alertFailureCount * 4
    )
  );
