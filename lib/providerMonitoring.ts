import "server-only";

import { prisma } from "@/lib/prisma";
import { AVAILABLE_MODELS, type AiProvider, type ModelTier } from "@/lib/models";

export type ProviderHealthStatus = "available" | "limited" | "outage";

export type ProviderFallback = {
  reason: string;
  recommendedModelIds: string[];
};

export type ProviderHealthRow = {
  provider: AiProvider;
  displayName: string;
  apiKeyConfigured: boolean;
  status: ProviderHealthStatus;
  successCount24h: number;
  failureCount24h: number;
  successRate24h: number | null;
  recentErrorCode: string | null;
  recentErrors: Array<{ code: string; count: number; updatedAt: string }>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  monthCostMicroUsd: number;
  monthBudgetMicroUsd: number;
  dayBudgetMicroUsd: number;
  budgetUsagePercent: number;
  balanceUsd: number | null;
  balanceSource: "manual" | "estimated" | "unavailable";
  alertLevel: "none" | "50" | "80" | "95";
  fallback: ProviderFallback;
};

const PROVIDER_DISPLAY_NAMES: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  moonshot: "Moonshot Kimi",
  qwen: "Qwen",
  zhipu: "Zhipu GLM",
  perplexity: "Perplexity",
};

const PROVIDER_API_KEY_ENV: Record<AiProvider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
  zhipu: ["ZHIPU_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
};

const FALLBACKS: Record<AiProvider, ProviderFallback> = {
  openai: { reason: "General model fallback", recommendedModelIds: ["gemini-2-5-flash", "claude-haiku-4-5", "llama-3-1"] },
  anthropic: { reason: "Writing and analysis fallback", recommendedModelIds: ["gpt-5-4-mini", "gemini-2-5-flash", "mistral-small-4"] },
  google: { reason: "Fast general fallback", recommendedModelIds: ["gpt-5-4-mini", "mistral-small-4", "llama-3-1"] },
  groq: { reason: "Fast open-model fallback", recommendedModelIds: ["mistral-small-4", "qwen3.6-flash", "deepseek-v4-flash"] },
  xai: { reason: "Current-answer fallback", recommendedModelIds: ["gpt-5-4-mini", "perplexity/sonar", "gemini-2-5-flash"] },
  deepseek: { reason: "Reasoning fallback", recommendedModelIds: ["qwen3.6-flash", "mistral-small-4", "gpt-5-4-mini"] },
  mistral: { reason: "EU/multilingual fallback", recommendedModelIds: ["llama-3-1", "qwen3.6-flash", "gpt-5-4-mini"] },
  moonshot: { reason: "Coding fallback", recommendedModelIds: ["codestral", "qwen3.7-plus", "deepseek-v4-pro"] },
  qwen: { reason: "Multilingual fallback", recommendedModelIds: ["mistral-small-4", "gemini-2-5-flash", "llama-3-1"] },
  zhipu: { reason: "GLM fallback", recommendedModelIds: ["qwen3.6-flash", "deepseek-v4-flash", "mistral-small-4"] },
  perplexity: { reason: "Search provider fallback; web-aware answer may be unavailable", recommendedModelIds: ["gpt-5-4-mini", "gemini-2-5-flash", "claude-haiku-4-5"] },
};

const providerSet = new Set<AiProvider>(
  AVAILABLE_MODELS.map((model) => model.provider)
);

export const MONITORED_PROVIDERS = Array.from(providerSet).filter(
  (provider) => provider !== "zhipu" || AVAILABLE_MODELS.some((model) => model.provider === provider)
);

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const positiveNumber = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const envProvider = (provider: AiProvider) => provider.toUpperCase();

const providerMonthlyBudgetMicroUsd = (provider: AiProvider) =>
  positiveInteger(
    process.env[`CHAT_PROVIDER_${envProvider(provider)}_COST_MICROUSD_PER_MONTH`],
    100_000_000
  );

const providerDailyBudgetMicroUsd = (provider: AiProvider) =>
  positiveInteger(
    process.env[`CHAT_PROVIDER_${envProvider(provider)}_COST_MICROUSD_PER_DAY`],
    10_000_000
  );

const balanceUsdFor = (provider: AiProvider) =>
  positiveNumber(process.env[`PROVIDER_${envProvider(provider)}_BALANCE_USD`]);

const periodStart = (period: "day" | "month", now = new Date()) =>
  period === "day"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const incrementBucket = async (key: string, period: string, amount = 1) => {
  await prisma.$executeRaw`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${period}, ${periodStart("day")}, ${amount}, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + ${amount},
      "updatedAt" = NOW()
  `;
};

const reserveDailyAlert = async (key: string) => {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, 'provider-alert-day', ${periodStart("day")}, 1, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO NOTHING
    RETURNING "count"
  `;
  return rows.length > 0;
};

const sendWebhook = async (url: string | undefined, payload: unknown) => {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("Provider alert webhook failed:", error);
  }
};

const sendProviderAlert = async (
  provider: AiProvider,
  title: string,
  detail: string
) => {
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  await Promise.all([
    sendWebhook(process.env.SLACK_WEBHOOK_URL, {
      text: `[Tomverse Admin] ${title}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${title}*\nProvider: ${displayName}\n${detail}`,
          },
        },
      ],
    }),
    sendWebhook(process.env.DISCORD_WEBHOOK_URL, {
      content: `**${title}**\nProvider: ${displayName}\n${detail}`,
    }),
  ]);

  if (process.env.ADMIN_ALERT_EMAIL) {
    console.warn(
      JSON.stringify({
        event: "provider_email_alert_pending",
        provider,
        title,
        email: process.env.ADMIN_ALERT_EMAIL,
      })
    );
  }
};

const maybeNotifyProviderFailure = async (
  provider: AiProvider,
  sanitizedCode: string
) => {
  const dayStart = periodStart("day");
  const failure = await prisma.chatUsageBucket.findUnique({
    where: {
      key_period_periodStart: {
        key: `provider:${provider}:failure`,
        period: "provider-health-day",
        periodStart: dayStart,
      },
    },
    select: { count: true },
  });
  const failureCount = failure?.count || 0;
  if (failureCount < 5) return;

  const reserved = await reserveDailyAlert(`provider-alert:${provider}:failure-surge`);
  if (!reserved) return;

  await sendProviderAlert(
    provider,
    "Provider failure surge",
    `Recent failures reached ${failureCount}. Last error: ${sanitizedCode}`
  );
};

export const notifyProviderBudgetIfNeeded = async (provider: AiProvider) => {
  const monthStart = periodStart("month");
  const usage = await prisma.chatUsageBucket.findUnique({
    where: {
      key_period_periodStart: {
        key: `provider:${provider}`,
        period: "provider-cost-month",
        periodStart: monthStart,
      },
    },
    select: { count: true },
  });
  const budget = providerMonthlyBudgetMicroUsd(provider);
  const used = usage?.count || 0;
  const percent = budget > 0 ? (used / budget) * 100 : 0;
  const level = percent >= 95 ? "95" : percent >= 80 ? "80" : percent >= 50 ? "50" : null;
  if (!level) return;

  const reserved = await reserveDailyAlert(`provider-alert:${provider}:budget:${level}`);
  if (!reserved) return;

  await sendProviderAlert(
    provider,
    `Provider budget ${level}% reached`,
    `Estimated monthly usage is ${moneyMicroUsd(used)} of ${moneyMicroUsd(budget)}.`
  );
};

const moneyMicroUsd = (value: number) => `$${(value / 1_000_000).toFixed(2)}`;

export const recordProviderSuccess = async (provider: AiProvider) => {
  await incrementBucket(`provider:${provider}:success`, "provider-health-day");
};

export const recordProviderFailure = async (
  provider: AiProvider | undefined,
  code: string
) => {
  if (!provider) return;
  const sanitizedCode = code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "UNKNOWN";
  await Promise.all([
    incrementBucket(`provider:${provider}:failure`, "provider-health-day"),
    incrementBucket(`provider:${provider}:error:${sanitizedCode}`, "provider-error-day"),
  ]);
  await maybeNotifyProviderFailure(provider, sanitizedCode);
};

type BucketRow = {
  key: string;
  period: string;
  count: number;
  updatedAt: Date;
};

const latestFor = (rows: BucketRow[], prefix: string) =>
  rows
    .filter((row) => row.key.startsWith(prefix))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

const countFor = (rows: BucketRow[], key: string, period: string) =>
  rows.find((row) => row.key === key && row.period === period)?.count || 0;

const configuredTierLimit = (tier: ModelTier) =>
  ({
    Free: process.env.CHAT_FREE_TIER_COST_MICROUSD_PER_DAY || "shared",
    Pro: process.env.CHAT_PRO_TIER_COST_MICROUSD_PER_DAY || "shared",
    Max: process.env.CHAT_MAX_TIER_COST_MICROUSD_PER_DAY || "shared",
  })[tier];

export const getProviderHealthDashboard = async () => {
  const now = new Date();
  const dayStart = periodStart("day", now);
  const monthStart = periodStart("month", now);
  const rows = await prisma.chatUsageBucket.findMany({
    where: {
      OR: [
        { period: "provider-health-day", periodStart: dayStart },
        { period: "provider-error-day", periodStart: dayStart },
        { period: "provider-cost-month", periodStart: monthStart },
        { period: "provider-cost-day", periodStart: dayStart },
      ],
    },
    select: {
      key: true,
      period: true,
      count: true,
      updatedAt: true,
    },
  });

  const providers: ProviderHealthRow[] = MONITORED_PROVIDERS.map((provider) => {
    const successKey = `provider:${provider}:success`;
    const failureKey = `provider:${provider}:failure`;
    const successCount24h = countFor(rows, successKey, "provider-health-day");
    const failureCount24h = countFor(rows, failureKey, "provider-health-day");
    const total = successCount24h + failureCount24h;
    const successRate24h = total > 0 ? Math.round((successCount24h / total) * 1000) / 10 : null;
    const recentError = latestFor(rows, `provider:${provider}:error:`);
    const recentErrorCode = recentError?.key.split(":error:")[1] || null;
    const recentErrors = rows
      .filter((row) => row.key.startsWith(`provider:${provider}:error:`))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 4)
      .map((row) => ({
        code: row.key.split(":error:")[1] || "UNKNOWN",
        count: row.count,
        updatedAt: row.updatedAt.toISOString(),
      }));
    const monthCostMicroUsd = countFor(rows, `provider:${provider}`, "provider-cost-month");
    const monthBudgetMicroUsd = providerMonthlyBudgetMicroUsd(provider);
    const dayBudgetMicroUsd = providerDailyBudgetMicroUsd(provider);
    const budgetUsagePercent =
      monthBudgetMicroUsd > 0
        ? Math.min(999, Math.round((monthCostMicroUsd / monthBudgetMicroUsd) * 1000) / 10)
        : 0;
    const balanceUsd = balanceUsdFor(provider);
    const apiKeyConfigured = PROVIDER_API_KEY_ENV[provider].some((key) => !!process.env[key]);
    const status: ProviderHealthStatus =
      !apiKeyConfigured || budgetUsagePercent >= 100 || failureCount24h >= Math.max(5, successCount24h)
        ? "outage"
        : failureCount24h > 0 || budgetUsagePercent >= 80
          ? "limited"
          : "available";
    const alertLevel =
      budgetUsagePercent >= 95
        ? "95"
        : budgetUsagePercent >= 80
          ? "80"
          : budgetUsagePercent >= 50
            ? "50"
            : "none";

    return {
      provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider],
      apiKeyConfigured,
      status,
      successCount24h,
      failureCount24h,
      successRate24h,
      recentErrorCode,
      recentErrors,
      lastSuccessAt: latestFor(rows, successKey)?.updatedAt.toISOString() || null,
      lastFailureAt: latestFor(rows, failureKey)?.updatedAt.toISOString() || null,
      monthCostMicroUsd,
      monthBudgetMicroUsd,
      dayBudgetMicroUsd,
      budgetUsagePercent,
      balanceUsd,
      balanceSource: balanceUsd === null ? "estimated" : "manual",
      alertLevel,
      fallback: FALLBACKS[provider],
    };
  });

  return {
    generatedAt: now.toISOString(),
    providers,
    tierLimits: {
      Free: configuredTierLimit("Free"),
      Pro: configuredTierLimit("Pro"),
      Max: configuredTierLimit("Max"),
    },
    notificationChannels: {
      email: !!process.env.ADMIN_ALERT_EMAIL,
      slack: !!process.env.SLACK_WEBHOOK_URL,
      discord: !!process.env.DISCORD_WEBHOOK_URL,
    },
  };
};
