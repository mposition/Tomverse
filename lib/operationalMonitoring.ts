import "server-only";

import * as Sentry from "@sentry/nextjs";

import { resolveSendingIdentity } from "@/lib/emailSendingIdentityCore";
import {
  operationalAlertCooldownMs,
  sanitizeOperationalContext,
  sanitizeOperationalStack,
  sanitizeOperationalText,
  type OperationalSeverity,
} from "@/lib/operationalMonitoringCore";
import { SLACK_ALERT_MENTION } from "@/lib/slackMessageTemplateCore";

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

/** An incident as an in-process observer sees it, after sanitisation. */
export type ObservedOperationalIncident = {
  code: string;
  title: string;
  severity: OperationalSeverity;
  context: Record<string, unknown>;
};

type IncidentObserver = (incident: ObservedOperationalIncident) => void;

/**
 * In-process listeners for incidents, so a test can assert one was raised.
 *
 * The alternative is matching the JSON line this module logs, which pins a
 * test to a log format rather than to the behaviour, and passes just as well
 * when the incident is written and never delivered. Observers see the same
 * sanitised payload the external channels do.
 *
 * Nothing on a request path registers one: an observer can only be added by
 * code running inside this process, and delivery is unaffected either way --
 * an observer that throws is swallowed below, because a listener must never
 * fail the incident it is watching.
 */
const incidentObservers = new Set<IncidentObserver>();

export const observeOperationalIncidents = (observer: IncidentObserver) => {
  incidentObservers.add(observer);
  return () => {
    incidentObservers.delete(observer);
  };
};

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

/**
 * The operator alert email.
 *
 * The sender comes from the one resolver every stream uses
 * (docs/policy/email-notifications.md §14.1: operator alerts travel on the
 * transactional identity). It used to carry its own variable and its own
 * literal, which is why it stayed on the old domain when the transactional
 * sender moved -- see docs/ops/email-sending-domains.md §1.2.
 *
 * The display name is gone with it. One transactional identity sends
 * everything, and "Operations" versus "Admin" stays where it already was and
 * where a mail client actually shows it: the subject prefix.
 *
 * Still a direct send rather than the outbox. An alert about the system being
 * unwell must not depend on the part of the system that drains a queue.
 */
const sendEmail = async (subject: string, detail: string) => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = (process.env.OPS_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL)?.trim();
  if (!apiKey || !to) return;
  const identity = resolveSendingIdentity("transactional", process.env);
  if (!identity.ok) {
    // Thrown rather than returned so `notifyExternalChannels` records it the
    // same way it records a webhook failure. It is caught there: a refused
    // sender must not stop Slack, Discord or the Sentry capture that already
    // happened above it.
    throw new Error(`Operational alert sender unusable: ${identity.code}`);
  }
  await postJson(
    "https://api.resend.com/emails",
    {
      from: identity.from,
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
  const slackText = `${SLACK_ALERT_MENTION}\n${prefix} ${title}\n${detail}`;
  const slackBlockText = `${SLACK_ALERT_MENTION}\n*${prefix} ${title}*\n${detail}`.slice(
    0,
    3_000
  );
  const results = await Promise.allSettled([
    postJson(slackUrl, {
      text: slackText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: slackBlockText,
          },
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

  // Before the cooldown gate, deliberately: an incident that repeats inside
  // the cooldown window is still an incident that happened, and an observer
  // that only saw the first one would report the second as never raised.
  for (const observe of incidentObservers) {
    try {
      observe({ code, title, severity, context: safeContext });
    } catch {
      // A listener must never fail the incident it is watching.
    }
  }

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
