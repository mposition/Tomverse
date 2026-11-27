import "server-only";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import {
  CLIENT_ERROR_LIMITS,
  CLIENT_ERROR_SOURCES,
  clientErrorFingerprint,
  normalizeClientErrorPath,
  redactClientErrorText,
} from "@/lib/clientErrorReportCore";
import { sanitizeOperationalText } from "@/lib/operationalMonitoringCore";

/**
 * Server half of browser error collection (app/api/diagnostics/client-error).
 *
 * This goes straight to Sentry instead of through `reportOperationalIncident`
 * on purpose. That function keeps one cooldown per incident code and posts to
 * Slack, Discord and email: right for "the database is down", wrong for a
 * stream of browser errors that nobody should be paged for, and the cooldown
 * would also drop every report after the first inside its window. Sentry
 * groups these on its own; the caps below only protect its quota.
 */

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * On unless `CLIENT_ERROR_REPORTING_ENABLED` says otherwise. Read per request,
 * so changing it needs no rebuild.
 */
export const clientErrorReportingEnabled = (
  env: Record<string, string | undefined> = process.env
) => !OFF_VALUES.has((env.CLIENT_ERROR_REPORTING_ENABLED ?? "").trim().toLowerCase());

/**
 * Fields are accepted generously and cut to their limit afterwards, so a
 * client that sends a long message still gets its report recorded, shortened.
 * The cap that matters is the body size the route reads.
 */
const text = (max: number, multiline = false) =>
  z
    .string()
    .max(max * 4)
    .transform((value) => redactClientErrorText(value, max, { multiline }));

export const clientErrorReportSchema = z.object({
  name: text(CLIENT_ERROR_LIMITS.name),
  message: text(CLIENT_ERROR_LIMITS.message),
  stack: text(CLIENT_ERROR_LIMITS.stack, true).optional(),
  source: z.enum(CLIENT_ERROR_SOURCES),
  label: z
    .string()
    .max(CLIENT_ERROR_LIMITS.label)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
  digest: z
    .string()
    .max(CLIENT_ERROR_LIMITS.digest)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
  path: z
    .string()
    .max(CLIENT_ERROR_LIMITS.path * 2)
    .transform((value) => normalizeClientErrorPath(value)),
  build: z
    .string()
    .max(CLIENT_ERROR_LIMITS.build)
    .regex(/^[A-Za-z0-9_.-]*$/),
  language: z
    .string()
    .max(CLIENT_ERROR_LIMITS.language)
    .regex(/^[A-Za-z0-9-]*$/),
  sessionId: z
    .string()
    .min(8)
    .max(CLIENT_ERROR_LIMITS.sessionId)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;

type Window = { start: number; count: number };

/** A fixed-window counter keyed by string, bounded so a key flood cannot grow it. */
const createLimiter = (windowMs: number, maxKeys: number) => {
  const windows = new Map<string, Window>();
  const allow = (key: string, limit: number, now = Date.now()) => {
    const current = windows.get(key);
    if (current && now - current.start < windowMs) {
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    }
    if (!current && windows.size >= maxKeys) {
      for (const [stored, window] of windows) {
        if (now - window.start >= windowMs) windows.delete(stored);
      }
      if (windows.size >= maxKeys) return false;
    }
    windows.set(key, { start: now, count: 1 });
    return true;
  };
  return Object.assign(allow, { clear: () => windows.clear() });
};

const MINUTE = 60_000;
const byAddress = createLimiter(MINUTE, 10_000);
const bySession = createLimiter(10 * MINUTE, 20_000);
const byFingerprint = createLimiter(10 * MINUTE, 2_000);
const overall = createLimiter(MINUTE, 1);

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Per address, before the body is read. In memory like the CSP report route,
 * and for the same reason: reporting an outage must not need the database the
 * outage may be in.
 */
export const allowClientErrorFromAddress = (address: string) =>
  byAddress(
    address,
    positiveInteger(process.env.CLIENT_ERROR_REPORTS_PER_IP_PER_MINUTE, 30)
  );

/** Per page load, then per error, then for the whole deployment. */
export const allowClientErrorReport = (report: ClientErrorReport) =>
  bySession(report.sessionId, 12) &&
  byFingerprint(clientErrorFingerprint(report), 10) &&
  overall(
    "all",
    positiveInteger(process.env.CLIENT_ERROR_REPORTS_PER_MINUTE, 120)
  );

/** Test hook: clears every counter. */
export const resetClientErrorLimitersForTests = () => {
  for (const limiter of [byAddress, bySession, byFingerprint, overall]) limiter.clear();
};

/**
 * Files one browser error in Sentry.
 *
 * The Error built here carries no server stack: a stack of this function would
 * be the same on every report and would group them all together. The browser
 * stack travels as context, and the fingerprint is the browser error's own.
 * The server SDK's `beforeSend` still runs over the event afterwards.
 */
export const recordClientErrorReport = (
  report: ClientErrorReport,
  request: { userAgent: string | null }
) => {
  const error = new Error(report.message);
  error.name = report.name || "Error";
  error.stack = `${error.name}: ${error.message}`;
  const userAgent = sanitizeOperationalText(request.userAgent ?? "", 200);

  console.warn(
    JSON.stringify({
      event: "client_error_reported",
      name: error.name,
      message: report.message,
      source: report.source,
      label: report.label,
      path: report.path,
      build: report.build,
      timestamp: new Date().toISOString(),
    })
  );

  try {
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTags({
        errorCode: "BROWSER_ERROR",
        routeClass: "browser",
        "client.source": report.source,
        "client.path": report.path,
        "client.build": report.build || "unknown",
        "client.language": report.language || "unknown",
        ...(report.label ? { "client.label": report.label } : {}),
      });
      scope.setContext("browser_error", {
        stack: report.stack,
        digest: report.digest,
        userAgent,
      });
      scope.setFingerprint(["browser-error", clientErrorFingerprint(report)]);
      return Sentry.captureException(error);
    });
  } catch {
    // Sentry being down must not change the answer to the browser.
  }
};
