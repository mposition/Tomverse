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
