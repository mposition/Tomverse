import * as Sentry from "@sentry/nextjs";
import {
  isNextNoFallbackError,
  isNextNoFallbackSentryEvent,
  sanitizeOperationalText,
} from "@/lib/operationalMonitoringCore";

const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0");

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(
    process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
  ),
  environment:
    process.env.SENTRY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.NODE_ENV,
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
