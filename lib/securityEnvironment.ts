import "server-only";

const strongSecret = (value: string | undefined) =>
  typeof value === "string" && value.trim().length >= 32;

const configured = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

export const getSecurityEnvironmentStatus = () => {
  const azureClientId = process.env.AZURE_AD_CLIENT_ID;
  const azureClientSecret = process.env.AZURE_AD_CLIENT_SECRET;
  const azureTenant = process.env.AZURE_AD_TENANT_ID?.trim();
  const azureRequested =
    configured(azureClientId) ||
    configured(azureClientSecret) ||
    configured(azureTenant);
  const azureTenantIsGeneric = ["common", "organizations", "consumers"].includes(
    azureTenant?.toLowerCase() || ""
  );

  const checks = {
    nextAuthSecret: strongSecret(process.env.NEXTAUTH_SECRET),
    oauthTokenEncryptionKey: strongSecret(
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY
    ),
    maintenanceSecret: strongSecret(process.env.MAINTENANCE_SECRET),
    azureSingleTenant:
      !azureRequested ||
      (configured(azureClientId) &&
        configured(azureClientSecret) &&
        configured(azureTenant) &&
        !azureTenantIsGeneric),
  };

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
  };
};
