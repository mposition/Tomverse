/**
 * What a browser error report may carry, and how it is cleaned.
 *
 * Shared by the browser reporter (lib/clientErrorReporter.ts) and the
 * collection route (lib/clientErrorReport.ts). Both run the same cleaning: the
 * browser does it so less leaves the device, the server does it again because
 * the server cannot trust what a browser sent. Nothing here imports a server
 * module or zod, so it is safe in a client bundle.
 *
 * A report is: error name, message, stack, page path without its query string,
 * build id, UI language, an opaque per-page-load id for rate limiting, and the
 * browser's own User-Agent header (read by the server, not sent by the page).
 * Never user input, conversation content, email, user id or conversation id.
 */

export const CLIENT_ERROR_REPORT_PATH = "/api/diagnostics/client-error";

/**
 * Set by the route when reporting is switched off. The page reads it once and
 * stops sending for the rest of that page load, so a deployment that turned
 * the switch off is not asked the same question on every error.
 */
export const CLIENT_ERROR_REPORTING_OFF_HEADER = "x-client-error-reporting";

export const CLIENT_ERROR_SOURCES = [
  "window-error",
  "unhandled-rejection",
  "react-boundary",
  "manual",
] as const;

export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

export const CLIENT_ERROR_LIMITS = {
  name: 80,
  message: 300,
  stack: 4_000,
  path: 200,
  build: 64,
  language: 16,
  digest: 64,
  label: 60,
  sessionId: 64,
} as const;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT =
  /(\b(?:password|secret|token|api[-_]?key|dsn)\s*[=:]\s*)[^\s,;&)'"]+/gi;
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g;
// An absolute URL, or a path with a query string, loses everything after `?`
// or `#`: login tokens, share tokens and conversation ids travel there.
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s)'"<>]+/gi;
const RELATIVE_QUERY = /(\/[\w./%-]*)[?#][^\s)'"<>]*/g;

const IDENTIFIER_LIKE = /^[A-Za-z_$][\w$.-]{0,40}$/;
const HARMLESS_QUOTED = new Set(["[object Object]", "undefined", "null", "NaN"]);

const isHarmlessQuoted = (inner: string) =>
  IDENTIFIER_LIKE.test(inner) ||
  HARMLESS_QUOTED.has(inner) ||
  /^[^\w\s]$/.test(inner);

/**
 * Engines quote the offending input inside some messages:
 *
 *   Unexpected token 'h', "hello wor"... is not valid JSON
 *   Invalid regular expression: /<what the user typed>/: ...
 *   Failed to execute 'querySelector' on 'Document': '<selector>' is not ...
 *
 * and a user's own text can be that input. Quoted text that is not a plain
 * identifier is therefore replaced; identifiers stay because they are what
 * makes `reading 'map'` readable. A token character is kept only when it is
 * punctuation (`'<'` is what an HTML error page parsed as JSON looks like).
 */
const redactQuotedInput = (text: string) =>
  text
    .replace(/(Invalid regular expression:?\s*)[^\n]*/gi, "$1[redacted]")
    .replace(/(Unexpected (?:token|character)\s+)'([^'\n]*)'/gi, (match, lead, token) =>
      /^[^\w\s]$/.test(token) ? match : `${lead}'[redacted]'`
    )
    .replace(/"([^"\n]*)"(\.\.\.)?/g, (match, inner) =>
      isHarmlessQuoted(inner) ? match : '"[redacted]"'
    )
    // No lookbehind: a regex literal Safari before 16.4 cannot parse would
    // fail the whole bundle, not just this rule.
    .replace(/([\s(:])'([^'\n]*)'(?=[\s).,:]|$)/g, (match, lead, inner) =>
      isHarmlessQuoted(inner) ? match : `${lead}'[redacted]'`
    );

// Keeps a trailing `:line:column`: in a stack the position follows the URL.
const stripUrlQuery = (url: string) => {
  const cut = url.search(/[?#]/);
  if (cut < 0) return url;
  return url.slice(0, cut) + (url.match(/(?::\d+){1,2}$/)?.[0] ?? "");
};

/**
 * Cleans free text from an error: control characters, URL query strings,
 * emails, ids, secret-looking values and quoted input. `multiline` keeps line
 * breaks (a stack) instead of folding them into spaces (a message).
 */
export const redactClientErrorText = (
  value: unknown,
  maxLength: number,
  options: { multiline?: boolean } = {}
) => {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARACTERS, "")
    .replace(ABSOLUTE_URL, stripUrlQuery)
    .replace(RELATIVE_QUERY, "$1");
  text = redactQuotedInput(text)
    .replace(EMAIL, "[email]")
    .replace(JWT, "[token]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(UUID, "[id]")
    .replace(LONG_OPAQUE, "[id]");
  text = options.multiline
    ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  return text.trim().slice(0, maxLength);
};

const OPAQUE_SEGMENT = /^[A-Za-z0-9_]{16,}$/;
const LONG_URLSAFE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

const isIdentifierSegment = (segment: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
  (OPAQUE_SEGMENT.test(segment) && /\d/.test(segment)) ||
  LONG_URLSAFE_SEGMENT.test(segment) ||
  segment.includes("@") ||
  segment.toLowerCase().includes("%40");

/**
 * The page a report came from: pathname only, no query string and no hash, and
 * any segment that looks like an identifier (a conversation id, a share
 * token) becomes `:id`.
 */
export const normalizeClientErrorPath = (value: unknown) => {
  const raw = typeof value === "string" ? value : "";
  const pathname = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
  const path = pathname
    .split("/")
    .map((segment) => (isIdentifierSegment(segment) ? ":id" : segment))
    .join("/")
    .replace(CONTROL_CHARACTERS, "")
    .slice(0, CLIENT_ERROR_LIMITS.path);
  return path.startsWith("/") ? path : `/${path}`;
};

/**
 * Noise that says nothing about the product: a request the user cancelled, an
 * extension's script, the browser's own resize notice, and a cross-origin
 * "Script error." that carries no information at all.
 */
export const isIgnorableClientError = (error: {
  name: string;
  message: string;
  stack?: string;
}) =>
  error.name === "AbortError" ||
  /\b(?:chrome|moz|safari-web|safari)-extension:\/\//i.test(error.stack || "") ||
  /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(
    error.message
  ) ||
  (error.message === "Script error." && !error.stack);

const topFrame = (stack: string | undefined) =>
  (stack || "")
    .split("\n")
    .find((line) => /^\s*(?:at\s|[^\s]*@)/.test(line))
    ?.trim() ?? "";

/**
 * One key for "the same error": name, message with its numbers folded, and the
 * top frame. Used to report an error once per page load in the browser and to
 * group and cap it on the server.
 */
export const clientErrorFingerprint = (error: {
  name: string;
  message: string;
  stack?: string;
}) =>
  [
    error.name,
    error.message.replace(/\d+/g, "#").slice(0, 120),
    topFrame(error.stack).replace(/:\d+(?::\d+)?\)?$/, "").slice(0, 160),
  ].join("|");
