import {
  CLIENT_ERROR_LIMITS,
  CLIENT_ERROR_REPORT_PATH,
  CLIENT_ERROR_REPORTING_OFF_HEADER,
  clientErrorFingerprint,
  isIgnorableClientError,
  normalizeClientErrorPath,
  redactClientErrorText,
  type ClientErrorSource,
} from "@/lib/clientErrorReportCore";

/**
 * Browser half of error collection: turns an error into a small report and
 * posts it to this app's own route (same origin, so the CSP needs no change).
 *
 * `reportClientError` is exported so other code can report a failure it has
 * already handled, for example a chat stream that timed out, with
 * `source: "manual"` and a short `label`.
 *
 * Nothing here may fail the page. Every path swallows its own errors, because
 * an error reporter that throws is an error source.
 */

/** Most reports one page load (one tab session of client navigations) sends. */
export const MAX_CLIENT_ERROR_REPORTS_PER_SESSION = 10;

const sentFingerprints = new Set<string>();
let sentCount = 0;
let reportingOff = false;
let sessionId = "";

/** Test hook: forgets what this page load has already sent. */
export const resetClientErrorReporterForTests = () => {
  sentFingerprints.clear();
  sentCount = 0;
  reportingOff = false;
  sessionId = "";
};

const pageLoadId = () => {
  if (!sessionId) {
    sessionId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
  return sessionId;
};

type ErrorLike = { name: string; message: string; stack?: string };

const describeThrown = (thrown: unknown): ErrorLike => {
  if (thrown && typeof thrown === "object") {
    const candidate = thrown as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof candidate.message === "string") {
      return {
        name: typeof candidate.name === "string" && candidate.name ? candidate.name : "Error",
        message: candidate.message,
        ...(typeof candidate.stack === "string" ? { stack: candidate.stack } : {}),
      };
    }
  }
  // A rejection with a string or an object is not an Error and has no stack.
  // Only the string's own text is kept; an object is reduced to its type.
  return {
    name: "NonErrorThrown",
    message: typeof thrown === "string" ? thrown : `[${typeof thrown}]`,
  };
};

export type ClientErrorReportOptions = {
  /** Next's `error.digest`, which matches a server-side log line. */
  digest?: string;
  /** A short fixed name for a handled failure, e.g. "chat-stream-timeout". */
  label?: string;
};

export function reportClientError(
  thrown: unknown,
  source: ClientErrorSource,
  options: ClientErrorReportOptions = {}
): void {
  try {
    if (reportingOff || typeof window === "undefined") return;
    if (sentCount >= MAX_CLIENT_ERROR_REPORTS_PER_SESSION) return;

    const described = describeThrown(thrown);
    const error = {
      name: redactClientErrorText(described.name, CLIENT_ERROR_LIMITS.name),
      message: redactClientErrorText(described.message, CLIENT_ERROR_LIMITS.message),
      stack: described.stack
        ? redactClientErrorText(described.stack, CLIENT_ERROR_LIMITS.stack, {
            multiline: true,
          })
        : undefined,
    };
    if (isIgnorableClientError(error)) return;

    const fingerprint = clientErrorFingerprint(error);
    if (sentFingerprints.has(fingerprint)) return;
    sentFingerprints.add(fingerprint);
    sentCount += 1;

    const label = options.label
      ? options.label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, CLIENT_ERROR_LIMITS.label)
      : undefined;
    const body = JSON.stringify({
      ...error,
      source,
      ...(label ? { label } : {}),
      ...(options.digest
        ? { digest: options.digest.slice(0, CLIENT_ERROR_LIMITS.digest) }
        : {}),
      path: normalizeClientErrorPath(window.location.pathname),
      build: (process.env.NEXT_PUBLIC_APP_VERSION || "").slice(0, CLIENT_ERROR_LIMITS.build),
      language: (document.documentElement.lang || "").slice(0, CLIENT_ERROR_LIMITS.language),
      sessionId: pageLoadId(),
    });

    // keepalive so a report sent while the page is unloading still leaves;
    // credentials omitted because the route reads no session and an identity
    // cookie would only be something to leak.
    void fetch(CLIENT_ERROR_REPORT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
    })
      .then((response) => {
        if (response.headers.get(CLIENT_ERROR_REPORTING_OFF_HEADER)) reportingOff = true;
      })
      .catch(() => {});
  } catch {
    // Reporting must never become the next error.
  }
}

/** Starts collecting uncaught errors and unhandled rejections. Returns the stop function. */
export function installClientErrorListeners(): () => void {
  const onError = (event: ErrorEvent) => {
    if (event.error) {
      reportClientError(event.error, "window-error");
      return;
    }
    // A cross-origin script reports only "Script error."; anything else here
    // is a message with at most a script position.
    reportClientError(
      {
        name: "Error",
        message: event.message,
        stack: event.filename
          ? `at ${event.filename}:${event.lineno}:${event.colno}`
          : undefined,
      },
      "window-error"
    );
  };
  const onRejection = (event: PromiseRejectionEvent) =>
    reportClientError(event.reason, "unhandled-rejection");

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
