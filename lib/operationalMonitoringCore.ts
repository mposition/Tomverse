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

export const operationalAlertCooldownMs = (value: string | undefined) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 10 * 60 * 1_000;
  return Math.min(86_400, Math.max(60, Math.round(seconds))) * 1_000;
};
