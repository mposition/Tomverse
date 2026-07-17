import "server-only";

import { getInfrastructureDashboard } from "@/lib/infrastructureMonitoring";
import type {
  InfrastructureDashboard,
  InfrastructureStatus,
} from "@/lib/infrastructureTypes";
import { sendManagedSlackMessage } from "@/lib/managedSlack";

const money = (value: number | null) =>
  value === null ? "not available" : `$${(value / 1_000_000).toFixed(2)}`;

const integer = (value: number | null) =>
  value === null ? "not available" : new Intl.NumberFormat("en-US").format(value);

const bytes = (value: number | null) => {
  if (value === null) return "not available";
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

const percent = (value: number | null) =>
  value === null ? "not available" : `${value.toFixed(1)}%`;

const marker = (status: InfrastructureStatus) =>
  status === "healthy"
    ? ":large_green_circle:"
    : status === "warning" || status === "unconfigured"
      ? ":large_orange_circle:"
      : ":red_circle:";

export const infrastructureSlackVariables = (
  dashboard: InfrastructureDashboard
) => {
  const generatedAt = new Date(dashboard.generatedAt);
  return {
    localDate: new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeZone: "Australia/Brisbane",
    }).format(generatedAt),
    statusSummary: [
      `${marker(dashboard.railway.status)} Railway ${dashboard.railway.status}`,
      `${marker(dashboard.r2.status)} R2 ${dashboard.r2.status}`,
      `${marker(dashboard.database.status)} Database ${dashboard.database.status}`,
      `${marker(dashboard.prismaUsage.status)} Prisma ${dashboard.prismaUsage.status}`,
    ].join(" · "),
    railwayCost: money(dashboard.railway.projectedMonthCostMicroUsd),
    railwayCredit: money(dashboard.railway.configuredCreditMicroUsd),
    railwayBalance: money(dashboard.railway.projectedBalanceMicroUsd),
    r2Storage: bytes(dashboard.r2.storageBytes),
    r2Objects: integer(dashboard.r2.objectCount),
    r2ClassA: percent(dashboard.r2.classAAllowancePercent),
    r2ClassB: percent(dashboard.r2.classBAllowancePercent),
    dbSessions: integer(dashboard.database.activeSessions),
    dbConversations: integer(dashboard.database.conversations),
    dbMessages: integer(dashboard.database.messages),
    dbProviderErrors: integer(dashboard.database.providerErrors24h),
    prismaOperations:
      dashboard.prismaUsage.operationsUsed === null
        ? "not available"
        : `${integer(dashboard.prismaUsage.operationsUsed)} / ${integer(
            dashboard.prismaUsage.operationsLimit
          )}`,
    prismaAllowance: percent(dashboard.prismaUsage.operationsAllowancePercent),
    prismaStorage:
      dashboard.prismaUsage.storageGiB === null
        ? "not available"
        : `${dashboard.prismaUsage.storageGiB.toFixed(2)} GiB`,
    generatedAt: new Intl.DateTimeFormat("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Australia/Brisbane",
      timeZoneName: "short",
    }).format(generatedAt),
  };
};

export async function sendDailyInfrastructureSlackReport(input?: {
  dashboard?: InfrastructureDashboard;
  test?: boolean;
}) {
  const dashboard = input?.dashboard || (await getInfrastructureDashboard());
  return sendManagedSlackMessage({
    key: "infrastructure_daily",
    variables: infrastructureSlackVariables(dashboard),
    webhookUrl:
      process.env.INFRASTRUCTURE_SLACK_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL,
    targetType: "Infrastructure",
    targetId: "daily-report",
    test: input?.test,
  });
}
