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

  // Production traffic must be authenticated as Cloudflare-origin traffic.
  // Never trust a client-controlled x-real-ip fallback on the public service.
  if (process.env.NODE_ENV === "production") return "unknown";

  return normalizeIp(request.headers.get(RAILWAY_IP_HEADER)) || "unknown";
}

/**
 * Identity to use for rate-limiting requests that have no authenticated user.
 * Falling back to the bare "unknown" sentinel from getTrustedClientIp would
 * collapse every anonymous caller (across the whole deployment) into a single
 * shared bucket whenever the trusted-proxy IP header isn't resolvable. Mix in
 * a couple of low-entropy client-supplied signals so distinct legitimate
 * clients don't collide with each other; this does not add protection against
 * a deliberate attacker (who can spoof these headers too), it only prevents
 * unrelated users from throttling one another under that misconfiguration.
 */
export function getAnonymousClientKey(request: Request) {
  const trustedIp = getTrustedClientIp(request);
  if (trustedIp !== "unknown") return trustedIp;

  const userAgent = request.headers.get("user-agent") || "";
  const acceptLanguage = request.headers.get("accept-language") || "";
  const fingerprint = createHash("sha256")
    .update(`${userAgent}|${acceptLanguage}`)
    .digest("hex")
    .slice(0, 16);
  return `unknown:${fingerprint}`;
}
