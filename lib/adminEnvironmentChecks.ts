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
      name: "RESEND_WEBHOOK_SECRET",
      configured: isConfigured(process.env.RESEND_WEBHOOK_SECRET),
      description:
        "Svix signing secret for Resend delivery, bounce and complaint events. " +
        "Without it the webhook answers 503 so events queue at the provider " +
        "rather than being dropped -- but nothing reaches the suppression list " +
        "until it is set, so bounced addresses keep being sent to.",
    },
    {
      name: "EMAIL_UNSUBSCRIBE_KEYS",
      configured: isConfigured(process.env.EMAIL_UNSUBSCRIBE_KEYS),
      description:
        "Keys for unsubscribe links, as version:secret pairs. Marketing mail " +
        "refuses to send without one, and /api/ready refuses the deployment " +
        "once MARKETING_EMAIL_FROM is set -- so set this one first. Old " +
        "versions must stay listed for as long as mail carrying them is in " +
        "the wild: dropping a version does not invalidate those links, it " +
        "breaks them, and a broken unsubscribe link's alternative is the spam " +
        "button.",
    },
    {
      name: "EMAIL_SNAPSHOT_KEYS",
      configured: isConfigured(process.env.EMAIL_SNAPSHOT_KEYS),
      description:
        "Envelope keys for the personalisation inputs the standard email lane " +
        "stores, as version:secret pairs. Without it that lane refuses to " +
        "enqueue rather than storing them in the clear. Old versions must stay " +
        "listed for as long as the rows they sealed are retained.",
    },
    {
      name: "EMAIL_BUSINESS_LEGAL_NAME",
      configured: isConfigured(process.env.EMAIL_BUSINESS_LEGAL_NAME),
      description:
        "The sender's registered name, printed in the jurisdiction footer of " +
        "every message. Unset means transactional mail goes out without a " +
        "footer -- loudly, as email_jurisdiction_footer_degraded -- and " +
        "marketing mail is refused outright, because an advertisement that " +
        "does not say who sent it is the thing every anti-spam statute names " +
        "first. Nothing is defaulted: a placeholder would satisfy the renderer " +
        "and put a false statement of identity in the footer.",
    },
    {
      name: "EMAIL_BUSINESS_POSTAL_ADDRESS",
      configured: isConfigured(process.env.EMAIL_BUSINESS_POSTAL_ADDRESS),
      description:
        "The sender's physical address. Required by every profile's footer, " +
        "and the one field CAN-SPAM names explicitly.",
    },
    {
      name: "EMAIL_BUSINESS_CONTACT_EMAIL",
      configured: isConfigured(process.env.EMAIL_BUSINESS_CONTACT_EMAIL),
      description:
        "The address a recipient can reply to about the mail itself, printed " +
        "in the footer. Not the sending address.",
    },
    {
      name: "EMAIL_BUSINESS_REGISTRATION_NUMBER",
      configured: isConfigured(process.env.EMAIL_BUSINESS_REGISTRATION_NUMBER),
      description:
        "사업자등록번호. Only the KR profile's footer prints it, so it is not " +
        "needed until mail is sent to a Korean recipient -- at which point its " +
        "absence refuses marketing and degrades the rest.",
    },
    {
      name: "EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER",
      configured: isConfigured(
        process.env.EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER
      ),
      description: "통신판매업 신고번호. KR profile only, as above.",
    },
    {
      name: "EMAIL_BUSINESS_ABN",
      configured: isConfigured(process.env.EMAIL_BUSINESS_ABN),
      description:
        "Australian Business Number. AU profile only; the Spam Act asks for " +
        "accurate sender identification rather than the ABN by name, and the " +
        "profile prints it because it is the identifier an Australian " +
        "recipient can check.",
    },
    {
      name: "TRANSACTIONAL_EMAIL_FROM",
      configured: true,
      description:
        "Verified sender used for account and billing emails. Defaults to " +
        "hello@tomverse.app, which is the registrable domain rather than the " +
        "sending subdomain docs/policy/email-notifications.md §14.1 moves it " +
        "to -- /api/ready reports that as a warning until the DNS move is done.",
    },
    {
      name: "MARKETING_EMAIL_FROM",
      configured: isConfigured(process.env.MARKETING_EMAIL_FROM),
      description:
        "Sender for marketing mail, on its own domain. Absent today and that " +
        "is correct: marketing is production-disabled, and the send path " +
        "refuses rather than falling back to the transactional address -- a " +
        "promotion sent from the transactional domain puts its spam " +
        "complaints on the domain that carries login codes.",
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
