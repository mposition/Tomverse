// Environment switch for the Railway *usage* monitor only, kept pure so the
// server-only snapshot module and unit tests share one definition.
//
// Why this exists: production and staging point at the same Railway
// Project-Access-Token, so both 15-minute Credit Reconciliation runs used to
// query `estimatedUsage` at the same moment and hit Railway's "16 concurrent
// usage queries per client" limit. Removing the token from staging would also
// break the deployment metadata lookup in lib/buildInfo.ts, which shares the
// same token but is a different concern -- so this flag never applies there.
export const RAILWAY_USAGE_MONITOR_FLAG_ENV = "RAILWAY_USAGE_MONITOR_ENABLED";

// Default-on, and only the exact literal "false" (after trimming and
// lowercasing) turns it off. A missing variable, an empty string, "true", or
// any unrecognised value keeps the historical behaviour, so an environment
// that never sets the variable -- production -- is unchanged.
export const railwayUsageMonitorEnabledFromValue = (
  value: string | null | undefined
): boolean => value?.trim().toLowerCase() !== "false";

export const railwayUsageMonitorEnabled = (
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  railwayUsageMonitorEnabledFromValue(env[RAILWAY_USAGE_MONITOR_FLAG_ENV]);
