import "server-only";

import type { AiProvider } from "@/lib/models";
import { recordProviderReportedUsage } from "@/lib/providerUsageAccounting";
import {
  MONITORED_PROVIDERS,
  PROVIDER_API_KEY_ENV,
  PROVIDER_DISPLAY_NAMES,
} from "@/lib/providerMonitoring";

export type ProviderUsageSyncStatus = "synced" | "skipped" | "failed";

export type ProviderUsageSyncResult = {
  provider: AiProvider;
  displayName: string;
  status: ProviderUsageSyncStatus;
  reportedCostMicroUsd: number | null;
  message: string;
};

const envProvider = (provider: AiProvider) => provider.toUpperCase();

const dayStartUtc = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const defaultProviderUsageSyncDate = () => {
  const now = new Date();
  return dayStartUtc(new Date(now.getTime() - 86_400_000));
};

const valueAtPath = (data: unknown, path: string) => {
  const parts = path.split(".").filter(Boolean);
  let value = data;
  for (const part of parts) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};

const numericValueAtPath = (data: unknown, path: string) => {
  const value = valueAtPath(data, path);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const configuredApiKey = (provider: AiProvider) =>
  PROVIDER_API_KEY_ENV[provider].map((key) => process.env[key]).find(Boolean);

const usageUrlFor = (provider: AiProvider, date: Date) => {
  const key = envProvider(provider);
  const url = process.env[`PROVIDER_${key}_USAGE_URL`];
  if (!url) return null;
  const dateText = date.toISOString().slice(0, 10);
  return url.replaceAll("{date}", dateText);
};

const usageAuthHeaderFor = (provider: AiProvider) => {
  const key = envProvider(provider);
  return (
    process.env[`PROVIDER_${key}_USAGE_AUTH_HEADER`] ||
    (configuredApiKey(provider) ? `Bearer ${configuredApiKey(provider)}` : undefined)
  );
};

export async function syncProviderUsageForDate(
  requestedDate = defaultProviderUsageSyncDate()
): Promise<ProviderUsageSyncResult[]> {
  const date = dayStartUtc(requestedDate);
  const results: ProviderUsageSyncResult[] = [];

  for (const provider of MONITORED_PROVIDERS) {
    const displayName = PROVIDER_DISPLAY_NAMES[provider];
    const url = usageUrlFor(provider, date);
    const jsonPath =
      process.env[`PROVIDER_${envProvider(provider)}_USAGE_COST_JSON_PATH`];

    if (!url || !jsonPath) {
      results.push({
        provider,
        displayName,
        status: "skipped",
        reportedCostMicroUsd: null,
        message: "Usage URL or cost JSON path is not configured.",
      });
      continue;
    }

    try {
      const authHeader = usageAuthHeaderFor(provider);
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
      });
      if (!response.ok) {
        results.push({
          provider,
          displayName,
          status: "failed",
          reportedCostMicroUsd: null,
          message: `Usage API returned ${response.status}.`,
        });
        continue;
      }

      const payload = (await response.json()) as unknown;
      const costUsd = numericValueAtPath(payload, jsonPath);
      if (costUsd === null || costUsd < 0) {
        results.push({
          provider,
          displayName,
          status: "failed",
          reportedCostMicroUsd: null,
          message: `Could not read a numeric USD cost at ${jsonPath}.`,
        });
        continue;
      }

      const reportedCostMicroUsd = Math.round(costUsd * 1_000_000);
      await recordProviderReportedUsage({
        provider,
        date,
        costMicroUsd: reportedCostMicroUsd,
        payload,
      });

      results.push({
        provider,
        displayName,
        status: "synced",
        reportedCostMicroUsd,
        message: "Provider usage was reconciled.",
      });
    } catch (error) {
      results.push({
        provider,
        displayName,
        status: "failed",
        reportedCostMicroUsd: null,
        message: error instanceof Error ? error.message : "Usage sync failed.",
      });
    }
  }

  return results;
}
