import "server-only";

import { isIP } from "node:net";

const ALLOWED_HEADERS = new Set([
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
]);

export function getTrustedClientIp(request: Request) {
  const configured = (
    process.env.TRUSTED_PROXY_IP_HEADER || "x-forwarded-for"
  ).toLowerCase();
  const header = ALLOWED_HEADERS.has(configured)
    ? configured
    : "x-forwarded-for";
  const raw = request.headers.get(header);
  if (!raw) return "unknown";

  const candidate =
    header === "x-forwarded-for"
      ? raw.split(",").at(-1)?.trim()
      : raw.trim();

  return candidate && isIP(candidate) ? candidate : "unknown";
}
