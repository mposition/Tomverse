export type OperationalSeverity = "warning" | "error" | "fatal";

const NEXT_NO_FALLBACK_ERROR_MESSAGE = "Internal: NoFallbackError";

type SentryLikeEvent = {
  message?: unknown;
  exception?: {
    values?: Array<{
      type?: unknown;
      value?: unknown;
    }>;
  };
};

const isNoFallbackMarker = (value: unknown) => {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return (
    normalized === NEXT_NO_FALLBACK_ERROR_MESSAGE ||
    normalized === `Error: ${NEXT_NO_FALLBACK_ERROR_MESSAGE}` ||
    normalized === "NoFallbackError"
  );
};

/**
 * Next.js throws NoFallbackError as an internal routing control signal. The
 * value passed to instrumentation hooks is not guaranteed to retain the
 * original Error prototype, so this check intentionally supports processed
 * and cross-realm error-like objects as well as Error instances.
 */
export const isNextNoFallbackError = (value: unknown) => {
  const visited = new Set<object>();

  const inspect = (candidate: unknown, depth: number): boolean => {
    if (isNoFallbackMarker(candidate)) return true;
    if (!candidate || typeof candidate !== "object" || depth > 3) return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);

    const errorLike = candidate as {
      name?: unknown;
      message?: unknown;
      digest?: unknown;
      cause?: unknown;
    };
    return (
      isNoFallbackMarker(errorLike.name) ||
      isNoFallbackMarker(errorLike.message) ||
      isNoFallbackMarker(errorLike.digest) ||
      inspect(errorLike.cause, depth + 1)
    );
  };

  return inspect(value, 0);
};

export const isNextNoFallbackSentryEvent = (event: SentryLikeEvent) =>
  isNextNoFallbackError(event.message) ||
  Boolean(
    event.exception?.values?.some(
      (exception) =>
        isNextNoFallbackError(exception.type) ||
        isNextNoFallbackError(exception.value)
    )
  );

const SECRET_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[-_]?key|dsn|database[-_]?url)/i;

const REDACTIONS: Array<[RegExp, string]> = [
  [/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+(?::[^\s/@]*)?@[^\s]+/gi, "[DATABASE_URL_REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/(\b(?:password|secret|token|api[-_]?key|dsn)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
];

const redactOperationalSecrets = (value: unknown) => {
  let text = value instanceof Error ? value.message : String(value ?? "Unknown error");
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
};

export const sanitizeOperationalText = (value: unknown, maxLength = 1_000) => {
  return redactOperationalSecrets(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
};

export const sanitizeOperationalStack = (value: unknown, maxLength = 8_000) =>
  redactOperationalSecrets(value).replace(/\r\n/g, "\n").slice(0, maxLength);

export const sanitizeOperationalContext = (
  context: Record<string, unknown> | undefined
) => {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      if (SECRET_KEY_PATTERN.test(key)) return [key, "[REDACTED]"];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        return [
          key,
          typeof value === "string"
            ? sanitizeOperationalText(value, 500)
            : value,
        ];
      }
      return [key, sanitizeOperationalText(JSON.stringify(value), 500)];
    })
  );
};

/**
 * Request headers whose values may leave the process inside an error report.
 *
 * This is an allowlist because the denylist it replaced could only name the
 * secret-carrying headers someone had already thought of. `x-tomverse-origin-verify`
 * carries `CLOUDFLARE_ORIGIN_SECRET` -- the shared value that proves a request
 * reached the origin through Cloudflare rather than around it -- and matched
 * none of `authorization|cookie|token|api[-_]?key`, so every event with request
 * headers shipped it in plaintext to a third-party system.
 *
 * A header not named here is reported as present with its value redacted, so
 * the shape of a request stays legible without its contents. Adding one is a
 * deliberate decision: the question is not "is this header useful" but "is this
 * value safe to store outside our infrastructure".
 */
const REPORTABLE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "content-length",
  "content-type",
  "host",
  "origin",
  "priority",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-railway-edge",
  "x-railway-request-id",
  "x-request-start",
]);

/**
 * `referer` is deliberately absent. A magic-link sign-in lands on a URL whose
 * query carries the login token, and the next request from that page reports it
 * as the referrer. `event.request.url` already says which endpoint failed.
 */
export const redactReportableRequestHeaders = (
  headers: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      REPORTABLE_REQUEST_HEADERS.has(name.trim().toLowerCase())
        ? value
        : "[REDACTED]",
    ])
  );
};

export const operationalAlertCooldownMs = (value: string | undefined) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 10 * 60 * 1_000;
  return Math.min(86_400, Math.max(60, Math.round(seconds))) * 1_000;
};
