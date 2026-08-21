import { isAllowedRequestHost } from "@/lib/originProtection";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Server-to-server callers that cannot send an Origin header, and are
// authenticated by something stronger than one: a provider signature, an OAuth
// state parameter, or a shared maintenance secret. Anything added here has to
// carry its own proof of origin -- this list is the only thing standing between
// a path and being callable cross-site.
const EXEMPT_MUTATION_PATHS = [
  "/api/auth/callback/",
  "/api/billing/webhook",
  "/api/internal/",
  "/api/security/csp-report",
  // Resend delivery, bounce and complaint events, verified by their Svix
  // signature in the route itself (lib/svixSignature.ts).
  "/api/webhooks/",
  // RFC 8058 one-click unsubscribe. The mailbox provider POSTs this on the
  // recipient's behalf and sends no Origin header, so the check would reject
  // every one -- and a one-click unsubscribe that silently fails is what the
  // spam button is for. Authenticated by the token instead, which can only
  // ever switch one purpose off for one subject (lib/unsubscribeToken.ts).
  "/api/unsubscribe",
];

const parseOrigin = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const firstHeaderValue = (value: string | null) =>
  value?.split(",", 1)[0]?.trim().toLowerCase() || null;

const hasMatchingPublicOrigin = (request: Request, value: string | null) => {
  const provided = parseOrigin(value);
  if (!provided) return false;

  // Reverse proxies can expose their internal origin through request.url even
  // though the browser correctly sends the public Origin and Host. The Host is
  // independently allow-listed by the proxy before this function is called, so
  // compare against that public boundary instead of the internal request URL.
  const requestHost = firstHeaderValue(request.headers.get("host"));
  if (requestHost && isAllowedRequestHost(requestHost)) {
    if (provided.host.toLowerCase() !== requestHost) return false;

    const forwardedProtocol = firstHeaderValue(
      request.headers.get("x-forwarded-proto")
    );
    if (forwardedProtocol === "https" || forwardedProtocol === "http") {
      return provided.protocol === `${forwardedProtocol}:`;
    }

    // Public production origins must use HTTPS. Local development keeps the
    // protocol from request.url so localhost HTTP continues to work.
    if (process.env.NODE_ENV === "production") {
      return provided.protocol === "https:";
    }

    const requestUrl = parseOrigin(request.url);
    return Boolean(requestUrl && provided.protocol === requestUrl.protocol);
  }

  // Request instances created outside Next.js (including unit tests) may not
  // contain a Host header. In that case, fall back to the URL origin.
  const expected = parseOrigin(request.url);
  return Boolean(
    expected &&
      provided.origin.toLowerCase() === expected.origin.toLowerCase()
  );
};

export const requiresMutationOriginCheck = (method: string, pathname: string) =>
  !SAFE_METHODS.has(method.toUpperCase()) &&
  !EXEMPT_MUTATION_PATHS.some((path) =>
    path.endsWith("/") ? pathname.startsWith(path) : pathname === path
  );

export const hasValidMutationOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  if (origin) return hasMatchingPublicOrigin(request, origin);

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "same-origin") return true;

  return hasMatchingPublicOrigin(request, request.headers.get("referer"));
};
