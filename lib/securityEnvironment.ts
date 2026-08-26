import "server-only";

import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { providerApiKeyFor } from "@/lib/emailProviderPortCore";
import { stripeKeyLiveMode } from "@/lib/stripeMode";

const strongSecret = (value: string | undefined) =>
  typeof value === "string" && value.trim().length >= 32;

const configured = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

const isPrivateDatabaseHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname.endsWith(".internal") ||
  hostname.endsWith(".railway.internal") ||
  hostname.startsWith("10.") ||
  hostname.startsWith("192.168.") ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);

const databaseTransportStatus = (value: string | undefined) => {
  if (!configured(value)) return false;
  try {
    const url = new URL(value!);
    if (isPrivateDatabaseHost(url.hostname.toLowerCase())) return true;
    return ["verify-full", "verify-ca"].includes(
      (url.searchParams.get("sslmode") || "").toLowerCase()
    );
  } catch {
    return false;
  }
};

const isHttpsUrl = (value: string | undefined) => {
  if (!configured(value)) return false;
  try {
    return new URL(value!.trim()).protocol === "https:";
  } catch {
    return false;
  }
};

export const getSecurityEnvironmentStatus = () => {
  const azureClientId = process.env.AZURE_AD_CLIENT_ID;
  const azureClientSecret = process.env.AZURE_AD_CLIENT_SECRET;
  const azureTenant = process.env.AZURE_AD_TENANT_ID?.trim();
  const azureRequested =
    configured(azureClientId) ||
    configured(azureClientSecret) ||
    configured(azureTenant);
  // Two different questions, and only one of them used to be asked here.
  // `production` is the build mode: it decides whether a rule applies at all,
  // and staging answers yes to it because staging is a production build.
  // `deployment` is which environment this actually is, which is what a rule
  // about live payment credentials has to be written against.
  const production = process.env.NODE_ENV === "production";
  const deployment = resolveDeploymentEnvironment();
  const turnstileConfigured =
    configured(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) &&
    configured(process.env.TURNSTILE_SECRET_KEY) &&
    configured(process.env.TURNSTILE_EXPECTED_HOSTNAME);
  const alertChannelConfigured =
    configured(process.env.OPS_ALERT_SLACK_WEBHOOK_URL) ||
    configured(process.env.SLACK_WEBHOOK_URL) ||
    configured(process.env.OPS_ALERT_DISCORD_WEBHOOK_URL) ||
    configured(process.env.DISCORD_WEBHOOK_URL) ||
    // Through the resolver: a deployment that sets only the stream-specific
    // name has a working email channel, and reading RESEND_API_KEY alone would
    // report it as having none.
    (configured(providerApiKeyFor("transactional", process.env) ?? undefined) &&
      (configured(process.env.OPS_ALERT_EMAIL) ||
        configured(process.env.ADMIN_ALERT_EMAIL)));
  const databaseUrls = [
    process.env.DATABASE_URL,
    process.env.DIRECT_DATABASE_URL,
  ].filter(configured);

  const checks = {
    nextAuthSecret: strongSecret(process.env.NEXTAUTH_SECRET),
    // SEC-010. The public URL decides cookie scope and every absolute URL the
    // app generates. An http origin in production means a session cookie an
    // attacker on the network can read, so this fails closed rather than
    // warning.
    nextAuthUrlIsHttps:
      !production || isHttpsUrl(process.env.NEXTAUTH_URL),
    oauthTokenEncryptionKey: strongSecret(
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY
    ),
    maintenanceSecret: strongSecret(process.env.MAINTENANCE_SECRET),
    azureOAuthConfiguration:
      !azureRequested ||
      (configured(azureClientId) &&
        configured(azureClientSecret) &&
        configured(azureTenant)),
    cspEnforcement: !production || process.env.CSP_MODE === "enforce",
    stripeWebhookSecret:
      !production || configured(process.env.STRIPE_WEBHOOK_SECRET),
    // A test-mode key in production turns Stripe's test cards into real app
    // entitlements. Readiness must fail before the load balancer sends traffic.
    //
    // The mirror image is just as bad and used to be unasked: a *live* key in
    // staging bills real cards from throwaway test flows. This was written as
    // `!production || live`, where `production` meant NODE_ENV -- and staging
    // is a production build, so it inherited "must be live", a rule it must
    // never satisfy. Staging's readiness was therefore 503 forever, which cost
    // more than the endpoint: a check that is always failing cannot report
    // that something else broke, and every /api/ready emitted a fatal
    // operational incident nobody could act on.
    //
    // Each deployment now asserts the mode it is supposed to have. An unknown
    // key shape (null) satisfies neither, so it fails both ways.
    stripeLiveMode:
      deployment === "production"
        ? stripeKeyLiveMode(process.env.STRIPE_SECRET_KEY) === true
        : deployment === "staging"
          ? stripeKeyLiveMode(process.env.STRIPE_SECRET_KEY) === false
          : true,
    providerUsageSyncSecret:
      !production || strongSecret(process.env.PROVIDER_USAGE_SYNC_SECRET),
    cloudflareOriginProtection:
      !production ||
      (process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET === "true" &&
        strongSecret(process.env.CLOUDFLARE_ORIGIN_SECRET)),
    trustedClientIpHeader:
      !production ||
      process.env.TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase() ===
        "cf-connecting-ip",
    turnstile: !production || turnstileConfigured,
    operationalAlertChannel: !production || alertChannelConfigured,
    sentry: !production || configured(process.env.SENTRY_DSN),
    // Every Playwright-only variable, not just the two that grant access.
    // `E2E_ASSISTANT_KNOWLEDGE_ENABLED` turns a feature flag on from the
    // environment, and a production server reading a flag out of its own
    // environment is exactly the misconfiguration this check exists to catch --
    // its loopback guard would already refuse it, and a readiness gate that
    // stayed green while it was set would be reporting on a narrower set of
    // variables than the one that actually exists.
    e2eBypassDisabled:
      !production ||
      (process.env.E2E_AUTH_BYPASS !== "true" &&
        process.env.E2E_DISABLE_DATABASE !== "true" &&
        process.env.E2E_ASSISTANT_KNOWLEDGE_ENABLED !== "true"),
    databaseTransportSecurity:
      !production ||
      (databaseUrls.length > 0 && databaseUrls.every(databaseTransportStatus)),
  };

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
  };
};
