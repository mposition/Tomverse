export type OperationalSeverity = "warning" | "error" | "fatal";

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
