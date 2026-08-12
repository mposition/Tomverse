import { isAllowedRequestHost } from "@/lib/originProtection";

const removeControlCharacters = (value: unknown, maxLength: number) =>
  String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, maxLength);

export const sanitizeCspReportedUrl = (value: unknown) => {
  const raw = removeControlCharacters(value, 2_048).trim();
  if (!raw) return "";

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !["http", "https"].includes(scheme)) {
    return `${scheme}:`;
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return raw.split(/[?#]/, 1)[0].slice(0, 500);
  }
};

/**
 * `line:column` from whichever spelling the reporting browser used, and only
 * when the line is a real number. Kept as one short string so the incident
 * context gains a position without gaining two more fields that are usually
 * absent.
 *
 * Why a position at all: `script-src blocked eval` on a page says nothing
 * about who called eval. Paired with the source file it separates our own
 * bundle from an allowed third-party tag from a browser extension, which is
 * the whole question such a report raises.
 */
export const cspSourcePosition = (report: Record<string, unknown>) => {
  const asPosition = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const line = asPosition(report["line-number"] ?? report.lineNumber);
  if (line === null) return "";
  const column = asPosition(report["column-number"] ?? report.columnNumber);
  return column === null ? String(line) : `${line}:${column}`;
};

export const isTrustedCspDocumentUri = (value: unknown) => {
  const raw = removeControlCharacters(value, 2_048).trim();
  if (!raw) return false;

  try {
    const url = new URL(raw);
    return (
      (url.protocol === "https:" ||
        (process.env.NODE_ENV !== "production" && url.protocol === "http:")) &&
      !url.username &&
      !url.password &&
      isAllowedRequestHost(url.host)
    );
  } catch {
    return false;
  }
};

/**
 * Schemes that mean "code a browser extension injected into the user's page".
 *
 * `sanitizeCspReportedUrl` reduces any non-http(s) source to its bare scheme,
 * so this compares against that reduced form and never sees which extension it
 * was -- which is the point: the identity of a user's extensions is theirs.
 *
 * Safari reports extension sources as `webkit-masked-url://hidden/`, already
 * anonymised by the browser; it is included for the same reason.
 */
export const BROWSER_EXTENSION_SOURCE_SCHEMES = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-extension:",
  "safari-web-extension:",
  "ms-browser-extension:",
  "webkit-masked-url:",
]);

/**
 * Whether a violation came from an extension rather than from anything the
 * deployment serves.
 *
 * Deliberately an allow-list of extension schemes rather than "not http(s)".
 * `data:` and `blob:` sources are also non-http(s) and are exactly what an
 * injected-script attack looks like, so they must keep reporting. An unknown
 * or absent source keeps reporting too: silence about a violation nobody can
 * attribute is the opposite of what this endpoint is for.
 */
export const isBrowserExtensionCspSource = (sanitizedSourceFile: string) =>
  BROWSER_EXTENSION_SOURCE_SCHEMES.has(sanitizedSourceFile.trim().toLowerCase());
