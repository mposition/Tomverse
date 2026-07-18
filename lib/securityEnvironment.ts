import "server-only";

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

export const getSecurityEnvironmentStatus = () => {
  const azureClientId = process.env.AZURE_AD_CLIENT_ID;
  const azureClientSecret = process.env.AZURE_AD_CLIENT_SECRET;
  const azureTenant = process.env.AZURE_AD_TENANT_ID?.trim();
  const azureRequested =
    configured(azureClientId) ||
    configured(azureClientSecret) ||
    configured(azureTenant);
  const production = process.env.NODE_ENV === "production";
  const turnstileConfigured =
    configured(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) &&
    configured(process.env.TURNSTILE_SECRET_KEY) &&
    configured(process.env.TURNSTILE_EXPECTED_HOSTNAME);
  const alertChannelConfigured =
    configured(process.env.OPS_ALERT_SLACK_WEBHOOK_URL) ||
    configured(process.env.SLACK_WEBHOOK_URL) ||
    configured(process.env.OPS_ALERT_DISCORD_WEBHOOK_URL) ||
    configured(process.env.DISCORD_WEBHOOK_URL) ||
    (configured(process.env.RESEND_API_KEY) &&
      (configured(process.env.OPS_ALERT_EMAIL) ||
        configured(process.env.ADMIN_ALERT_EMAIL)));
  const databaseUrls = [
    process.env.DATABASE_URL,
    process.env.DIRECT_DATABASE_URL,
  ].filter(configured);

  const checks = {
    nextAuthSecret: strongSecret(process.env.NEXTAUTH_SECRET),
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
    e2eBypassDisabled:
      !production ||
      (process.env.E2E_AUTH_BYPASS !== "true" &&
        process.env.E2E_DISABLE_DATABASE !== "true"),
    databaseTransportSecurity:
      !production ||
      (databaseUrls.length > 0 && databaseUrls.every(databaseTransportStatus)),
  };

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
  };
};
