import * as Sentry from "@sentry/nextjs";
import { isNextNoFallbackError } from "@/lib/operationalMonitoringCore";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError: typeof Sentry.captureRequestError = (
  error,
  request,
  context
) => {
  // Next.js uses this as an internal route-fallback control signal. It is not
  // an application failure and should not be reported as an incident.
  if (isNextNoFallbackError(error)) {
    return;
  }
  Sentry.captureRequestError(error, request, context);
};
