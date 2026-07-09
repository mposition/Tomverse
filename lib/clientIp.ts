import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const CLOUDFLARE_IP_HEADER = "cf-connecting-ip";
const CLOUDFLARE_ORIGIN_HEADER = "x-tomverse-origin-verify";
const RAILWAY_IP_HEADER = "x-real-ip";

const normalizeIp = (value: string | null) => {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
};

const hasValidCloudflareOriginSecret = (request: Request) => {
  const expected = process.env.CLOUDFLARE_ORIGIN_SECRET;
  const provided = request.headers.get(CLOUDFLARE_ORIGIN_HEADER);
  if (!expected || expected.length < 32 || !provided) return false;

  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

export function getTrustedClientIp(request: Request) {
  const configured = (
    process.env.TRUSTED_PROXY_IP_HEADER || RAILWAY_IP_HEADER
  ).toLowerCase();

  if (
    configured === CLOUDFLARE_IP_HEADER &&
    hasValidCloudflareOriginSecret(request)
  ) {
    return normalizeIp(request.headers.get(CLOUDFLARE_IP_HEADER)) || "unknown";
  }

  return normalizeIp(request.headers.get(RAILWAY_IP_HEADER)) || "unknown";
}
