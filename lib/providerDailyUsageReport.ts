import "server-only";

import { sendManagedSlackMessage } from "@/lib/managedSlack";
import type { ProviderHealthDashboard } from "@/lib/providerMonitoring";
import type { ProviderUsageSyncResult } from "@/lib/providerUsageSync";

const microUsd = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "Not available"
    : `$${(value / 1_000_000).toFixed(2)}`;

const balanceLabel = (
  provider: ProviderHealthDashboard["providers"][number]
) => {
  const tracksCredit =
    provider.provider === "zhipu" ||
    provider.billingProfile.settlementModel === "prepaid" ||
    provider.billingProfile.settlementModel === "hybrid";
  if (!tracksCredit) {
    return `headroom ${microUsd(provider.internalBudgetHeadroomMicroUsd)}`;
  }
  if (provider.balanceAmount !== null) {
    return `balance ${provider.balanceCurrency} ${provider.balanceAmount.toFixed(2)} (${provider.balanceSource})`;
  }
  if (provider.credit.estimatedBalanceMicroUsd !== null) {
    return `balance ${microUsd(provider.credit.estimatedBalanceMicroUsd)} (estimated)`;
  }
  return "balance not available";
};

export async function sendDailyProviderUsageSlackReport({
  date,
  results,
  dashboard,
  test,
}: {
  date: string;
  results: ProviderUsageSyncResult[];
  dashboard: ProviderHealthDashboard;
  test?: boolean;
}) {
  const rows = dashboard.providers.map((provider) => {
    const result = results.find((item) => item.provider === provider.provider);
    const usage = result?.reportedCostMicroUsd ?? result?.internalCostMicroUsd;
    const marker =
      provider.status === "outage"
        ? ":red_circle:"
        : provider.status === "limited" || result?.status === "failed"
          ? ":large_orange_circle:"
          : ":large_green_circle:";
    return `${marker} *${provider.displayName}* · ${balanceLabel(provider)} · usage ${microUsd(usage)} · sync ${result?.status || "not run"}`;
  });
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const delivery = await sendManagedSlackMessage({
    key: "provider_usage_daily",
    variables: {
      date,
      providerRows: rows.join("\n"),
      failed,
      skipped,
      generatedAt: dashboard.generatedAt.slice(0, 16).replace("T", " "),
    },
    webhookUrl:
      process.env.PROVIDER_USAGE_SLACK_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL,
    targetType: "ProviderUsage",
    targetId: date,
    test,
  });
  return { ...delivery, failed, skipped };
}
