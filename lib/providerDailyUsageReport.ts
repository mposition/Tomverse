import "server-only";

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
}: {
  date: string;
  results: ProviderUsageSyncResult[];
  dashboard: ProviderHealthDashboard;
}) {
  const webhookUrl =
    process.env.PROVIDER_USAGE_SLACK_WEBHOOK_URL ||
    process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error(
      "PROVIDER_USAGE_SLACK_WEBHOOK_URL or SLACK_WEBHOOK_URL is required for the daily provider report."
    );
  }
  const target = new URL(webhookUrl);
  if (target.protocol !== "https:") {
    throw new Error("The provider usage Slack webhook must use HTTPS.");
  }

  const rows = dashboard.providers.map((provider) => {
    const result = results.find((item) => item.provider === provider.provider);
    const usage = result?.reportedCostMicroUsd ?? result?.internalCostMicroUsd;
    const marker =
      provider.status === "outage"
        ? ":red_circle:"
        : provider.status === "limited" || result?.status === "failed"
          ? ":large_orange_circle:"
          : ":large_green_circle:";
    return `${marker} *${provider.displayName}* · ${balanceLabel(provider)} · usage ${microUsd(usage)} · sync ${result?.status || "missing"}`;
  });
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const text = [
    `*Tomverse daily provider usage · ${date} UTC*`,
    ...rows,
    `*Summary* · failed ${failed} · skipped ${skipped} · generated ${dashboard.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
  ].join("\n");

  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `Tomverse daily provider usage · ${date} UTC`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Daily provider usage Slack webhook returned ${response.status}.`);
  }
  return { delivered: true, failed, skipped };
}
