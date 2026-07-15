import "server-only";

import * as Sentry from "@sentry/nextjs";
import {
  operationalAlertCooldownMs,
  sanitizeOperationalContext,
  sanitizeOperationalStack,
  sanitizeOperationalText,
  type OperationalSeverity,
} from "@/lib/operationalMonitoringCore";

type OperationalIncident = {
  code: string;
  title: string;
  error?: unknown;
  severity?: OperationalSeverity;
  context?: Record<string, unknown>;
  cooldownMs?: number;
  forceNotification?: boolean;
};

type DependencyStatus = OperationalIncident & {
  dependency: string;
  healthy: boolean;
};

type OperationalState = {
  lastNotifiedAt: Map<string, number>;
  dependencies: Map<string, "healthy" | "unhealthy">;
};

const globalState = globalThis as typeof globalThis & {
  __tomverseOperationalState?: OperationalState;
};

const state =
  globalState.__tomverseOperationalState ||
  (globalState.__tomverseOperationalState = {
    lastNotifiedAt: new Map(),
    dependencies: new Map(),
  });

const ALERT_TIMEOUT_MS = 5_000;

const severityLabel = (severity: OperationalSeverity) =>
  severity === "fatal" ? "FATAL" : severity === "error" ? "ERROR" : "WARNING";

const safeError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return new Error(sanitizeOperationalText(error));
  }
  const sanitized = new Error(sanitizeOperationalText(error.message));
  sanitized.name = sanitizeOperationalText(error.name, 120) || "Error";
  if (error.stack) sanitized.stack = sanitizeOperationalStack(error.stack);
  return sanitized;
};

const postJson = async (
  url: string | undefined,
  body: unknown,
  headers: Record<string, string> = {}
) => {
  if (!url?.trim()) return;
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw new Error("Operational alert endpoints must use HTTPS.");
  }
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Operational alert webhook returned ${response.status}.`);
  }
};

const sendEmail = async (subject: string, detail: string) => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = (process.env.OPS_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL)?.trim();
  if (!apiKey || !to) return;
  await postJson(
    "https://api.resend.com/emails",
    {
      from:
        process.env.ADMIN_ALERT_FROM?.trim() ||
        "Tomverse Operations <alerts@tomverse.app>",
      to: [to],
      subject: `[Tomverse Operations] ${subject}`,
      text: detail,
    },
    {
      Authorization: `Bearer ${apiKey}`,
    }
  );
};

const notifyExternalChannels = async ({
  title,
  detail,
  severity,
}: {
  title: string;
  detail: string;
  severity: OperationalSeverity;
}) => {
  const prefix = `[${severityLabel(severity)}] [Tomverse Operations]`;
  const slackUrl =
    process.env.OPS_ALERT_SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  const discordUrl =
    process.env.OPS_ALERT_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  const results = await Promise.allSettled([
    postJson(slackUrl, {
      text: `${prefix} ${title}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${prefix} ${title}*\n${detail}` },
        },
      ],
    }),
    postJson(discordUrl, { content: `**${prefix} ${title}**\n${detail}` }),
    sendEmail(title, detail),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          event: "operational_alert_delivery_failed",
          message: sanitizeOperationalText(result.reason),
          timestamp: new Date().toISOString(),
        })
      );
    }
  }
};

export async function reportOperationalIncident({
  code,
  title,
  error,
  severity = "error",
  context,
  cooldownMs = operationalAlertCooldownMs(
    process.env.OPS_ALERT_COOLDOWN_SECONDS
  ),
  forceNotification = false,
}: OperationalIncident) {
  const safeContext = sanitizeOperationalContext(context);
  const message = sanitizeOperationalText(error);
  const timestamp = new Date().toISOString();
  console.error(
    JSON.stringify({
      event: "operational_incident",
      code,
      title,
      severity,
      message,
      context: safeContext,
      timestamp,
    })
  );

  const lastNotifiedAt = state.lastNotifiedAt.get(code) || 0;
  if (!forceNotification && Date.now() - lastNotifiedAt < cooldownMs) {
    return { notified: false, suppressed: true };
  }
  state.lastNotifiedAt.set(code, Date.now());

  const capturedError = safeError(error || title);
  const eventId = Sentry.withScope((scope) => {
    scope.setLevel(severity);
    scope.setTag("operational.code", code);
    scope.setTag("operational.component", String(safeContext.component || "unknown"));
    scope.setContext("operational", safeContext);
    return Sentry.captureException(capturedError);
  });
  const detail = [
    `Code: ${code}`,
    `Severity: ${severity}`,
    `Message: ${message}`,
    ...Object.entries(safeContext).map(([key, value]) => `${key}: ${String(value)}`),
    `Sentry event: ${eventId}`,
    `Time: ${timestamp}`,
  ].join("\n");
  await notifyExternalChannels({ title, detail, severity });
  await Sentry.flush(2_000).catch(() => false);
  return { notified: true, suppressed: false, eventId };
}

export async function reportOperationalDependencyStatus({
  dependency,
  healthy,
  code,
  title,
  error,
  severity,
  context,
  cooldownMs,
}: DependencyStatus) {
  const previous = state.dependencies.get(dependency);
  state.dependencies.set(dependency, healthy ? "healthy" : "unhealthy");

  if (!healthy) {
    return reportOperationalIncident({
      code,
      title,
      error,
      severity,
      context: { ...context, dependency },
      cooldownMs,
      forceNotification: previous !== "unhealthy",
    });
  }

  if (previous === "unhealthy") {
    return reportOperationalIncident({
      code: `${code}_RECOVERED`,
      title: `${title} recovered`,
      error: "Dependency check is healthy again.",
      severity: "warning",
      context: { ...context, dependency, recovered: true },
      forceNotification: true,
    });
  }
  return { notified: false, suppressed: false };
}
