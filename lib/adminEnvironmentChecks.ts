/**
 * Deployment configuration the Admin Console reports on.
 *
 * Extracted from the old monolithic workspace so the Overview page can own it
 * and no other route pays to compute it. Reads only presence and shape --
 * never a value -- so nothing here can leak a secret into a rendered page.
 *
 * ## Why each row carries a severity
 *
 * The table used to answer one question -- is this set? -- and the health score
 * counted the "no"s. That made `DISCORD_WEBHOOK_URL`, whose own description
 * says "Optional secondary incident notification channel", cost more than a
 * provider running in a limited state, and it let a deployment that is
 * correctly configured read as broken. On 2026-09-14 seven of twenty-nine rows
 * were reported missing; two were optional channels, three belonged to
 * jurisdictions this deployment may never send to, and one -- MARKETING_EMAIL_FROM
 * -- is documented in its own description as correctly absent.
 *
 * Two rows already knew how to say "not a problem here": `AZURE_AD_*` reports
 * configured when Azure sign-in was never requested, and `TRANSACTIONAL_EMAIL_FROM`
 * reports configured because it has a default. This gives the same distinction
 * to the other twenty-seven instead of to two.
 *
 * ## Why `conditional` is not `not applicable`
 *
 * A KR or AU footer value is needed only when a message goes to a recipient who
 * resolves to that jurisdiction, and **whether such a recipient exists is not a
 * fact an environment holds** -- which is exactly why
 * `businessIdentityProblems()` keeps those findings at warning severity even
 * when marketing is on. So this file does not claim they are fine. It names the
 * condition, keeps them out of the score, and leaves the judgement with the
 * operator. Same shape as the release-gate report's `applicability_unknown`.
 */

import { providerApiKeyFor } from "@/lib/emailProviderPortCore";

/**
 * How much a missing value costs.
 *
 * - `required`   -- something is broken or unprotected right now. Scored.
 * - `conditional`-- needed only when a runtime condition holds, and the
 *                   environment cannot say whether it does. Not scored; the
 *                   condition is named so a human can decide.
 * - `recommended`-- observability or reporting is degraded. Nothing a user
 *                   meets. Not scored.
 * - `optional`   -- nothing is lost. Not scored.
 */
export type AdminEnvSeverity =
  | "required"
  | "conditional"
  | "recommended"
  | "optional";

export type AdminEnvCheck = {
  name: string;
  configured: boolean;
  description: string;
  severity: AdminEnvSeverity;
  /**
   * For `conditional` rows: the fact that decides whether the value is needed,
   * written for somebody who has to go and find out what it is.
   */
  condition?: string;
};

const isConfigured = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

const isStrongSecret = (value: string | undefined) =>
  typeof value === "string" && value.trim().length >= 32;

const isGa4MeasurementId = (value: string | undefined) =>
  typeof value === "string" && /^G-[A-Z0-9]+$/.test(value.trim());

/**
 * When the process that answered this request started.
 *
 * `process.env` is captured at process start, so a variable added to the host
 * afterwards is not in it and no amount of refreshing will bring it in -- the
 * console re-renders inside the same process. Reported beside the table
 * because "not configured" and "configured after this process started" look
 * identical from here and send an operator to entirely different places. It
 * cost a whole diagnosis on 2026-09-14: three variables were present in the
 * deployment host and absent from the running process, and the panel said only
 * that they were not configured.
 *
 * Derived from `process.uptime()` rather than a module-load timestamp: a module
 * evaluated lazily would date itself from first use rather than from boot.
 */
export const processStartedAt = (now: Date = new Date()): Date =>
  new Date(now.getTime() - Math.round(process.uptime() * 1000));

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

  // Marketing's own sending identity is what turns the unsubscribe keyring and
  // the business identity from "owed" into "refusing every send". Read once,
  // through the same predicate `lib/emailUnsubscribeReadiness.ts` uses, so the
  // console and `/api/ready` cannot disagree about whether marketing is on.
  const marketingConfigured = isConfigured(process.env.MARKETING_EMAIL_FROM);

  return [
    {
      name: "NEXTAUTH_SECRET",
      configured: isStrongSecret(process.env.NEXTAUTH_SECRET),
      severity: "required",
      description: "Requires a stable, high-entropy value of at least 32 characters.",
    },
    {
      name: "OAUTH_TOKEN_ENCRYPTION_KEY",
      configured: isStrongSecret(process.env.OAUTH_TOKEN_ENCRYPTION_KEY),
      severity: "required",
      description: "Dedicated 32+ character key required for OAuth token encryption.",
    },
    {
      name: "AZURE_AD_*",
      configured: azureOAuthConfigurationComplete,
      severity: "required",
      description:
        "Client ID, client secret, and tenant ID must be configured together; common is supported for public sign-in.",
    },
    {
      name: "MAINTENANCE_SECRET",
      configured: isStrongSecret(process.env.MAINTENANCE_SECRET),
      severity: "required",
      description:
        "Protects the scheduled cleanup endpoint and must be at least 32 characters.",
    },
    {
      name: "ADMIN_EMAILS",
      configured: isConfigured(process.env.ADMIN_EMAILS),
      severity: "required",
      description: "Controls who can access this console.",
    },
    {
      name: "STRIPE_SECRET_KEY",
      configured: isConfigured(process.env.STRIPE_SECRET_KEY),
      severity: "required",
      description: "Required for checkout, refunds, and subscription cancellation.",
    },
    {
      name: "STRIPE_WEBHOOK_SECRET",
      configured: isConfigured(process.env.STRIPE_WEBHOOK_SECRET),
      severity: "required",
      description: "Required to trust Stripe billing events.",
    },
    {
      name: "GA4_MEASUREMENT_ID",
      configured: isGa4MeasurementId(process.env.GA4_MEASUREMENT_ID),
      severity: "recommended",
      description:
        "Public GA4 web data-stream identifier used after analytics consent.",
    },
    {
      name: "GA4_API_SECRET",
      configured: isConfigured(process.env.GA4_API_SECRET),
      severity: "recommended",
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
      severity: "recommended",
      description:
        "Railway project ID plus project/account token, or workspace ID plus workspace/account token.",
    },
    {
      name: "PRISMA_USAGE_API",
      configured:
        isConfigured(process.env.PRISMA_MANAGEMENT_API_TOKEN) &&
        isConfigured(process.env.PRISMA_DATABASE_ID),
      severity: "recommended",
      description:
        "Prisma service token and database ID used for monthly operations monitoring.",
    },
    {
      name: "RESEND_API_KEY",
      // Resolved rather than read: `TRANSACTIONAL_RESEND_API_KEY` also
      // configures this, and a screen that said "not configured" while mail
      // was sending would send somebody to fix a variable that is not the one
      // in use.
      configured: isConfigured(providerApiKeyFor("transactional", process.env) ?? undefined),
      severity: "required",
      description:
        "Required for Tomverse transactional email. TRANSACTIONAL_RESEND_API_KEY satisfies it too.",
    },
    {
      name: "SUPPORT_NOTIFICATION_EMAIL",
      configured:
        isConfigured(process.env.SUPPORT_NOTIFICATION_EMAIL) ||
        isConfigured(process.env.ADMIN_ALERT_EMAIL) ||
        isConfigured(process.env.ADMIN_EMAILS),
      severity: "required",
      description:
        "Receives website support form notifications. Falls back to ADMIN_ALERT_EMAIL or ADMIN_EMAILS.",
    },
    {
      name: "RESEND_WEBHOOK_SECRET",
      configured: isConfigured(process.env.RESEND_WEBHOOK_SECRET),
      severity: "required",
      description:
        "Svix signing secret for Resend delivery, bounce and complaint events. " +
        "Without it the webhook answers 503 so events queue at the provider " +
        "rather than being dropped -- but nothing reaches the suppression list " +
        "until it is set, so bounced addresses keep being sent to.",
    },
    {
      name: "EMAIL_UNSUBSCRIBE_KEYS",
      configured: isConfigured(process.env.EMAIL_UNSUBSCRIBE_KEYS),
      // The same conditional severity `unsubscribeKeyringProblems()` applies,
      // and for the same reason: gating on it while marketing is off would
      // refuse today's deployment to announce a capability nobody turned on.
      severity: marketingConfigured ? "required" : "conditional",
      condition:
        "Required once MARKETING_EMAIL_FROM is set. Set this one first: from that moment /api/ready refuses the deployment without it.",
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
      severity: "required",
      description:
        "Envelope keys for the personalisation inputs the standard email lane " +
        "stores, as version:secret pairs. Without it that lane refuses to " +
        "enqueue rather than storing them in the clear. Old versions must stay " +
        "listed for as long as the rows they sealed are retained.",
    },
    {
      name: "EMAIL_BUSINESS_LEGAL_NAME",
      configured: isConfigured(process.env.EMAIL_BUSINESS_LEGAL_NAME),
      severity: "required",
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
      severity: "required",
      description:
        "The sender's physical address. Required by every profile's footer, " +
        "and the one field CAN-SPAM names explicitly.",
    },
    {
      name: "EMAIL_BUSINESS_CONTACT_EMAIL",
      configured: isConfigured(process.env.EMAIL_BUSINESS_CONTACT_EMAIL),
      severity: "required",
      description:
        "The address a recipient can reply to about the mail itself, printed " +
        "in the footer. Not the sending address.",
    },
    {
      name: "EMAIL_BUSINESS_REGISTRATION_NUMBER",
      configured: isConfigured(process.env.EMAIL_BUSINESS_REGISTRATION_NUMBER),
      severity: "conditional",
      condition:
        "Needed only when a recipient resolves to the KR profile. Whether this deployment has Korean recipients is not something the environment can answer.",
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
      severity: "conditional",
      condition:
        "Needed only when a recipient resolves to the KR profile, as above.",
      description: "통신판매업 신고번호. KR profile only, as above.",
    },
    {
      name: "EMAIL_BUSINESS_ABN",
      configured: isConfigured(process.env.EMAIL_BUSINESS_ABN),
      severity: "conditional",
      condition:
        "Needed only when a recipient resolves to the AU profile. Absent, an Australian recipient receives no footer at all -- not a missing line, the whole block.",
      description:
        "Australian Business Number. AU profile only; the Spam Act asks for " +
        "accurate sender identification rather than the ABN by name, and the " +
        "profile prints it because it is the identifier an Australian " +
        "recipient can check.",
    },
    {
      name: "TRANSACTIONAL_EMAIL_FROM",
      configured: true,
      severity: "required",
      description:
        "Verified sender used for account and billing emails. Defaults to " +
        "hello@tomverse.app, which is the registrable domain rather than the " +
        "sending subdomain docs/policy/email-notifications.md §14.1 moves it " +
        "to -- /api/ready reports that as a warning until the DNS move is done.",
    },
    {
      name: "MARKETING_EMAIL_FROM",
      configured: isConfigured(process.env.MARKETING_EMAIL_FROM),
      // Its own description has said "Absent today and that is correct" since
      // it was written, while the score deducted for it anyway.
      severity: "conditional",
      condition:
        "Only set this when marketing is being turned on. Marketing is production-disabled, so absent is the correct state and setting it makes several other rows blocking.",
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
      severity: "optional",
      description: "Optional incident notification channel.",
    },
    {
      name: "PROVIDER_USAGE_SLACK_WEBHOOK_URL",
      configured:
        isConfigured(process.env.PROVIDER_USAGE_SLACK_WEBHOOK_URL) ||
        isConfigured(process.env.SLACK_WEBHOOK_URL),
      severity: "optional",
      description:
        "Daily provider usage and estimated-balance report channel. Falls back to SLACK_WEBHOOK_URL.",
    },
    {
      name: "DISCORD_WEBHOOK_URL",
      configured: isConfigured(process.env.DISCORD_WEBHOOK_URL),
      severity: "optional",
      description: "Optional secondary incident notification channel.",
    },
    {
      name: "SENTRY_DSN",
      configured: isConfigured(process.env.SENTRY_DSN),
      severity: "recommended",
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
        (isConfigured(providerApiKeyFor("transactional", process.env) ?? undefined) &&
          (isConfigured(process.env.OPS_ALERT_EMAIL) ||
            isConfigured(process.env.ADMIN_ALERT_EMAIL))),
      // The aggregate is what actually matters, which is why the three channels
      // it reads are optional individually: with Slack set, Discord's own row
      // being empty costs nothing and used to cost ten points.
      severity: "required",
      description:
        "At least one DB-independent Slack, Discord, or email incident channel.",
    },
  ];
}

/** Missing rows that mean something is broken now. The only ones scored. */
export const blockingEnvChecks = (checks: AdminEnvCheck[]) =>
  checks.filter((check) => check.severity === "required" && !check.configured);

/** Missing rows grouped by what their absence costs, for a screen to render. */
export const groupEnvChecksBySeverity = (checks: AdminEnvCheck[]) => ({
  required: checks.filter((c) => c.severity === "required" && !c.configured),
  conditional: checks.filter((c) => c.severity === "conditional" && !c.configured),
  recommended: checks.filter((c) => c.severity === "recommended" && !c.configured),
  optional: checks.filter((c) => c.severity === "optional" && !c.configured),
});
