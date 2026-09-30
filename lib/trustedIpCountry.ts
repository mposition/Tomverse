import "server-only";

import { getTrustedClientIp } from "@/lib/clientIp";

const CLOUDFLARE_IP_HEADER = "cf-connecting-ip";
const RAILWAY_IP_HEADER = "x-real-ip";

/**
 * Cloudflare's country estimate for this request, trusted exactly as far as
 * `getTrustedClientIp()` trusts the IP it came with: in production only on
 * traffic the origin secret proves is Cloudflare's, and never otherwise.
 *
 * A country a client can set by sending a header is not an estimate of
 * anything, and the sign-up screen records this one as the person's
 * jurisdiction (docs/policy/email-notifications.md §6.2 step 4).
 *
 * Its own module rather than a function in lib/clientIp.ts: that file is in the
 * marketing admission code closure (scripts/marketing-admission-code-core.mjs),
 * and changing its bytes would ask every scheduled post to be admitted again
 * for a change no admission decision turns on.
 */
export function getTrustedIpCountry(headers: Headers): string | null {
  if (process.env.NODE_ENV !== "production") return headers.get("cf-ipcountry");
  const configured = (process.env.TRUSTED_PROXY_IP_HEADER || RAILWAY_IP_HEADER).toLowerCase();
  if (configured !== CLOUDFLARE_IP_HEADER) return null;
  // In production `getTrustedClientIp()` answers a Cloudflare IP only when the
  // origin secret matched, and "unknown" otherwise.
  const proven = getTrustedClientIp(new Request("https://origin.invalid/", { headers }));
  return proven === "unknown" ? null : headers.get("cf-ipcountry");
}
