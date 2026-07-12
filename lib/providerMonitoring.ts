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
  balanceSource: "api" | "manual" | "estimated" | "unavailable";
  alertLevel: "none" | "50" | "80" | "95";
  fallback: ProviderFallback;
  modelIncidents: Array<{
    modelId: string;
    modelName: string;
    failureCount5m: number;
    recentErrorCode: string | null;
    updatedAt: string;
  }>;
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

const periodStart = (period: "day" | "month" | "five-minute", now = new Date()) => {
  if (period === "five-minute") {
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        Math.floor(now.getUTCMinutes() / 5) * 5
      )
    );
  }
  return period === "day"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const incrementBucket = async (
  key: string,
  period: string,
  amount = 1,
  start = periodStart("day")
) => {
  await prisma.$executeRaw`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
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

const recordNotificationLog = async ({
  channel,
  title,
  detail,
  status,
  targetType,
  targetId,
  error,
}: {
  channel: string;
  title: string;
  detail: string;
  status: "sent" | "failed" | "skipped";
  targetType?: string | null;
  targetId?: string | null;
  error?: string | null;
}) => {
  await prisma.adminNotificationLog
    .create({
      data: {
        channel,
        title,
        detail,
        status,
        targetType: targetType || null,
        targetId: targetId || null,
        error: error?.slice(0, 1_000) || null,
      },
    })
    .catch((logError) => {
      console.error("Admin notification log write failed:", logError);
    });
};

const sendWebhook = async (
  channel: "slack" | "discord",
  url: string | undefined,
  payload: unknown,
  log: { title: string; detail: string; targetType: string; targetId: string }
) => {
  if (!url) {
    await recordNotificationLog({
      channel,
      title: log.title,
      detail: log.detail,
      status: "skipped",
      targetType: log.targetType,
      targetId: log.targetId,
      error: "Webhook URL is not configured.",
    });
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}.`);
    }
    await recordNotificationLog({
      channel,
      title: log.title,
      detail: log.detail,
      status: "sent",
      targetType: log.targetType,
      targetId: log.targetId,
    });
  } catch (error) {
    console.error("Provider alert webhook failed:", error);
    await recordNotificationLog({
      channel,
      title: log.title,
      detail: log.detail,
      status: "failed",
      targetType: log.targetType,
      targetId: log.targetId,
      error: error instanceof Error ? error.message : "Webhook failed.",
    });
  }
};

const sendEmailAlert = async (
  title: string,
  detail: string,
  log: { targetType: string; targetId: string }
) => {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) {
    await recordNotificationLog({
      channel: "email",
      title,
      detail,
      status: "skipped",
      targetType: log.targetType,
      targetId: log.targetId,
      error: "ADMIN_ALERT_EMAIL is not configured.",
    });
    return;
  }

  const from = process.env.ADMIN_ALERT_FROM || "Tomverse Admin <alerts@tomverse.app>";
  const text = `${title}\n\n${detail}`;

  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `[Tomverse Admin] ${title}`,
          text,
        }),
      });
      if (!response.ok) {
        throw new Error(`Resend returned ${response.status}.`);
      }
      await recordNotificationLog({
        channel: "email",
        title,
        detail,
        status: "sent",
        targetType: log.targetType,
        targetId: log.targetId,
      });
    } catch (error) {
      console.error("Resend provider alert failed:", error);
      await recordNotificationLog({
        channel: "email",
        title,
        detail,
        status: "failed",
        targetType: log.targetType,
        targetId: log.targetId,
        error: error instanceof Error ? error.message : "Email failed.",
      });
    }
    return;
  }

  if (process.env.SENDGRID_API_KEY) {
    try {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from.includes("<") ? "alerts@tomverse.app" : from },
          subject: `[Tomverse Admin] ${title}`,
          content: [{ type: "text/plain", value: text }],
        }),
      });
      if (!response.ok) {
        throw new Error(`SendGrid returned ${response.status}.`);
      }
      await recordNotificationLog({
        channel: "email",
        title,
        detail,
        status: "sent",
        targetType: log.targetType,
        targetId: log.targetId,
      });
    } catch (error) {
      console.error("SendGrid provider alert failed:", error);
      await recordNotificationLog({
        channel: "email",
        title,
        detail,
        status: "failed",
        targetType: log.targetType,
        targetId: log.targetId,
        error: error instanceof Error ? error.message : "Email failed.",
      });
    }
    return;
  }

  console.warn(
    JSON.stringify({
      event: "provider_email_alert_not_configured",
      title,
      email: to,
    })
  );
  await recordNotificationLog({
    channel: "email",
    title,
    detail,
    status: "skipped",
    targetType: log.targetType,
    targetId: log.targetId,
    error: "Email provider is not configured.",
  });
};

const sendProviderAlert = async (
  provider: AiProvider,
  title: string,
  detail: string
) => {
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const log = {
    title,
    detail: `Provider: ${displayName}\n${detail}`,
    targetType: "Provider",
    targetId: provider,
  };
  await Promise.all([
    sendWebhook("slack", process.env.SLACK_WEBHOOK_URL, {
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
    }, log),
    sendWebhook("discord", process.env.DISCORD_WEBHOOK_URL, {
      content: `**${title}**\nProvider: ${displayName}\n${detail}`,
    }, log),
    sendEmailAlert(title, `Provider: ${displayName}\n${detail}`, {
      targetType: "Provider",
      targetId: provider,
    }),
  ]);
};

const modelFailureThreshold = () =>
  positiveInteger(process.env.CHAT_MODEL_FAILURES_PER_5_MIN_ALERT, 3);

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

export const recordModelSuccess = async (modelId: string) => {
  const windowStart = periodStart("five-minute");
  await incrementBucket(
    `model:${modelId}:success`,
    "model-health-5m",
    1,
    windowStart
  );
};

export const recordModelFailure = async (
  modelId: string | undefined,
  provider: AiProvider | undefined,
  code: string
) => {
  if (!modelId) return;
  const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
  const resolvedProvider = provider || model?.provider;
  const sanitizedCode = code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "UNKNOWN";
  const windowStart = periodStart("five-minute");
  await Promise.all([
    incrementBucket(`model:${modelId}:failure`, "model-health-5m", 1, windowStart),
    incrementBucket(`model:${modelId}:error:${sanitizedCode}`, "model-error-5m", 1, windowStart),
  ]);

  if (!resolvedProvider) return;

  const failure = await prisma.chatUsageBucket.findUnique({
    where: {
      key_period_periodStart: {
        key: `model:${modelId}:failure`,
        period: "model-health-5m",
        periodStart: windowStart,
      },
    },
    select: { count: true },
  });
  const failureCount = failure?.count || 0;
  if (failureCount < modelFailureThreshold()) return;

  const reserved = await reserveDailyAlert(
    `model-alert:${modelId}:${windowStart.toISOString()}`
  );
  if (!reserved) return;

  await sendProviderAlert(
    resolvedProvider,
    "Model failure for 5 minutes",
    `Model: ${model?.name || modelId}\nRecent 5-minute failures: ${failureCount}\nLast error: ${sanitizedCode}`
  );
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

const valueAtPath = (data: unknown, path: string) => {
  const parts = path.split(".").filter(Boolean);
  let value = data;
  for (const part of parts) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};

const firstNumericValue = (data: unknown, paths: string[]) => {
  for (const path of paths) {
    const value = valueAtPath(data, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const automaticBalanceFor = async (provider: AiProvider) => {
  const providerKey = envProvider(provider);
  const url = process.env[`PROVIDER_${providerKey}_BALANCE_URL`];
  if (!url) return null;

  const apiKey = PROVIDER_API_KEY_ENV[provider].map((key) => process.env[key]).find(Boolean);
  const authHeader =
    process.env[`PROVIDER_${providerKey}_BALANCE_AUTH_HEADER`] ||
    (apiKey ? `Bearer ${apiKey}` : undefined);
  const jsonPath = process.env[`PROVIDER_${providerKey}_BALANCE_JSON_PATH`];

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const value = firstNumericValue(
      data,
      jsonPath
        ? [jsonPath]
        : [
            "balance_usd",
            "balanceUsd",
            "balance",
            "credit",
            "credits",
            "data.balance_usd",
            "data.balance",
            "data.credit",
          ]
    );
    return value === null ? null : value;
  } catch (error) {
    console.error(`Provider balance lookup failed for ${provider}:`, error);
    return null;
  }
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
        { period: "model-health-5m", periodStart: periodStart("five-minute", now) },
        { period: "model-error-5m", periodStart: periodStart("five-minute", now) },
      ],
    },
    select: {
      key: true,
      period: true,
      count: true,
      updatedAt: true,
    },
  });

  const balanceByProvider = new Map(
    await Promise.all(
      MONITORED_PROVIDERS.map(async (provider) => [
        provider,
        await automaticBalanceFor(provider),
      ] as const)
    )
  );

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
    const automaticBalanceUsd = balanceByProvider.get(provider) ?? null;
    const manualBalanceUsd = balanceUsdFor(provider);
    const balanceUsd = automaticBalanceUsd ?? manualBalanceUsd;
    const providerModels = AVAILABLE_MODELS.filter((model) => model.provider === provider);
    const modelIncidents = providerModels
      .map((model) => {
        const failure = latestFor(rows, `model:${model.id}:failure`);
        const recentError = latestFor(rows, `model:${model.id}:error:`);
        const failureCount5m =
          failure?.period === "model-health-5m" ? failure.count : 0;
        if (failureCount5m <= 0) return null;
        return {
          modelId: model.id,
          modelName: model.name,
          failureCount5m,
          recentErrorCode: recentError?.key.split(":error:")[1] || null,
          updatedAt: (failure || recentError)?.updatedAt.toISOString() || now.toISOString(),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => b.failureCount5m - a.failureCount5m)
      .slice(0, 5);
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
      balanceSource:
        automaticBalanceUsd !== null
          ? "api"
          : manualBalanceUsd !== null
            ? "manual"
            : "estimated",
      alertLevel,
      fallback: FALLBACKS[provider],
      modelIncidents,
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
