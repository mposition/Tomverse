import * as Sentry from "@sentry/nextjs";

import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import {
  isNextNoFallbackError,
  isNextNoFallbackSentryEvent,
  sanitizeOperationalStack,
  sanitizeOperationalText,
} from "@/lib/operationalMonitoringCore";

const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0");

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(
    process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
  ),
  // SENTRY_ENVIRONMENT stays an explicit override; everything else is the one
  // shared answer. This used to skip APP_ENV, which is the variable staging
  // actually sets -- so every staging error arrived tagged `production` while
  // the same deployment's /api/build-info reported `staging`.
  environment:
    process.env.SENTRY_ENVIRONMENT || resolveDeploymentEnvironment(),
  release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA,
  sendDefaultPii: false,
  enableLogs: true,
  tracesSampleRate:
    Number.isFinite(tracesSampleRate) && tracesSampleRate >= 0
      ? Math.min(1, tracesSampleRate)
      : 0,
  ignoreErrors: ["Internal: NoFallbackError"],
  beforeSend(event, hint) {
    if (
      isNextNoFallbackError(hint?.originalException) ||
      isNextNoFallbackSentryEvent(event)
    ) {
      return null;
    }
    if (event.message) event.message = sanitizeOperationalText(event.message);
    for (const exception of event.exception?.values || []) {
      if (exception.value) {
        exception.value = sanitizeOperationalText(exception.value);
      }
      for (const frame of exception.stacktrace?.frames || []) {
        if (frame.context_line) {
          frame.context_line = sanitizeOperationalStack(frame.context_line, 500);
        }
        frame.vars = undefined;
      }
    }
    for (const breadcrumb of event.breadcrumbs || []) {
      if (breadcrumb.message) {
        breadcrumb.message = sanitizeOperationalText(breadcrumb.message, 500);
      }
      breadcrumb.data = undefined;
    }
    if (event.request) {
      event.request.data = undefined;
      event.request.cookies = undefined;
      if (event.request.headers) {
        const headers = { ...event.request.headers };
        for (const name of Object.keys(headers)) {
          if (/authorization|cookie|token|api[-_]?key/i.test(name)) {
            headers[name] = "[REDACTED]";
          }
        }
        event.request.headers = headers;
      }
    }
    if (event.user) {
      event.user = event.user.id ? { id: event.user.id } : undefined;
    }
    return event;
  },
});
