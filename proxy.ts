import { NextRequest, NextResponse } from "next/server";
import { createStaticMarketingCsp, createStrictCsp } from "@/lib/csp";
import {
  isStaticMarketingPathname,
  localizedMarketingRedirect,
} from "@/lib/marketingRoutes";
import { getStaticMarketingCspHashes } from "@/lib/staticMarketingCsp";
import {
  resolveThemePreference,
  THEME_COOKIE_NAME,
  THEME_HEADER,
} from "@/lib/theme";
import {
  getPublicReportOrigin,
  hasRequiredOriginSecret,
  isAllowedRequestHost,
} from "@/lib/originProtection";
import {
  hasValidMutationOrigin,
  requiresMutationOriginCheck,
} from "@/lib/requestOrigin";
import {
  DOCUMENT_LANGUAGE_HEADER,
  DOCUMENT_LANGUAGE_SOURCE_HEADER,
  isSupportedDocumentLanguage,
  resolveDocumentLanguage,
} from "@/lib/documentLanguage";

const blockedOriginResponse = () =>
  new NextResponse("Misdirected Request", {
    status: 421,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const isRouterPrefetch = (request: NextRequest) =>
  request.headers.has("next-router-prefetch") ||
  request.headers.get("purpose") === "prefetch";

const TRACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const safeHeaderHost = (value: string | null) => {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
};

const blockedMutationOriginResponse = (request: NextRequest) => {
  const providedTraceId = request.headers.get("x-request-id")?.trim() || "";
  const traceId = TRACE_ID_PATTERN.test(providedTraceId)
    ? providedTraceId
    : crypto.randomUUID();

  console.warn("Mutation origin rejected", {
    traceId,
    pathname: request.nextUrl.pathname,
    method: request.method,
    requestHost: request.headers.get("host"),
    requestUrlHost: request.nextUrl.host,
    originHost: safeHeaderHost(request.headers.get("origin")),
    forwardedProtocol: request.headers.get("x-forwarded-proto"),
    fetchSite: request.headers.get("sec-fetch-site"),
  });

  return NextResponse.json(
    {
      error: "Cross-site mutation request rejected.",
      code: "INVALID_REQUEST_ORIGIN",
      traceId,
    },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-ID": traceId,
      },
    }
  );
};

export function proxy(request: NextRequest) {
  // Container liveness must remain directly reachable by Railway. Readiness
  // performs database and monitoring work, so it goes through the same host
  // and Cloudflare origin-secret boundary as every other dynamic endpoint.
  if (request.nextUrl.pathname === "/api/health") {
    return NextResponse.next();
  }

  if (
    !isAllowedRequestHost(request.headers.get("host")) ||
    !hasRequiredOriginSecret(request.headers)
  ) {
    return blockedOriginResponse();
  }

  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    requiresMutationOriginCheck(request.method, request.nextUrl.pathname) &&
    !hasValidMutationOrigin(request)
  ) {
    return blockedMutationOriginResponse(request);
  }

  // Router prefetches fetch an RSC payload rather than a document, so they need
  // no nonce and no CSP header. They must still clear the host, origin-secret
  // and mutation-origin checks above: gating those on request headers would let
  // any caller opt out of the entire edge security layer.
  //
  // This sits ahead of the localized redirect below so that a prefetch keeps
  // behaving exactly as it did while the matcher excluded it -- the fix adds
  // the security checks to prefetches without also starting to redirect them.
  if (isRouterPrefetch(request)) {
    return NextResponse.next();
  }

  // R-05-LANG. Send a non-English visitor to their own localized page before
  // anything renders, rather than serving English HTML that the client rewrites
  // after first paint. See `localizedMarketingRedirect` for the measurements.
  //
  // Precedence is explicit request, then stored choice, then browser hint. The
  // cookie exists because `LanguageProvider` keeps the preference in
  // `localStorage`, which this cannot see: without it, a visitor who chose
  // English on a Korean browser would be dragged back to `/ko` every visit.
  const requestedLanguage = request.nextUrl.searchParams.get("lang");
  const storedLanguage = request.cookies.get("tomverse_lang")?.value;
  const preference = isSupportedDocumentLanguage(requestedLanguage)
    ? { language: requestedLanguage, source: "search" as const }
    : isSupportedDocumentLanguage(storedLanguage)
      ? { language: storedLanguage, source: "search" as const }
      : resolveDocumentLanguage({
          pathname: request.nextUrl.pathname,
          searchLanguage: null,
          acceptLanguage: request.headers.get("accept-language"),
        });
  const localizedTarget =
    request.method === "GET" || request.method === "HEAD"
      ? localizedMarketingRedirect({
          pathname: request.nextUrl.pathname,
          language: preference.language,
          source: preference.source,
        })
      : null;
  if (localizedTarget) {
    const target = request.nextUrl.clone();
    target.pathname = localizedTarget;
    // The handled parameter is consumed; everything else -- campaign tags, a
    // referral code -- survives the hop.
    target.searchParams.delete("lang");
    const redirect = NextResponse.redirect(target, 307);
    // Static marketing responses are cached by a shared cache for an hour. A
    // language-dependent redirect must never land in it, or the first Korean
    // visitor's hop would be replayed to everyone.
    redirect.headers.set("Cache-Control", "private, no-store");
    redirect.headers.set("Vary", "Accept-Language, Cookie");
    return redirect;
  }

  const isStaticMarketingRequest = isStaticMarketingPathname(
    request.nextUrl.pathname
  );
  const staticMarketingHashes = isStaticMarketingRequest
    ? getStaticMarketingCspHashes(request.nextUrl.pathname)
    : null;
  if (
    isStaticMarketingRequest &&
    process.env.NODE_ENV === "production" &&
    process.env.CSP_MODE === "enforce" &&
    !staticMarketingHashes
  ) {
    return new NextResponse("Static security policy unavailable", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const nonce = isStaticMarketingRequest
    ? null
    : Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = nonce
    ? createStrictCsp(nonce)
    : createStaticMarketingCsp(staticMarketingHashes || undefined);
  const enforce = process.env.CSP_MODE === "enforce";
  const policyHeader = enforce
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-tomverse-pathname", request.nextUrl.pathname);
  // The query string travels beside the path because a server component cannot
  // read either one. `app/not-found.tsx` needs both to hand a visitor back to
  // exactly where they were -- `/admin/refunds?status=pending`, not
  // `/admin/refunds` -- after they switch accounts. It is raw request input, so
  // every consumer normalizes it before putting it in a URL.
  requestHeaders.set("x-tomverse-search", request.nextUrl.search);
  // VAL-004. The root layout needs the document language before it renders
  // `<html>`, and it is the only place that can set that attribute. Only the
  // proxy sees the query string, the path prefix and `Accept-Language` at
  // once, so the resolution happens here and travels as one header.
  const documentLanguage = resolveDocumentLanguage({
    pathname: request.nextUrl.pathname,
    searchLanguage: request.nextUrl.searchParams.get("lang"),
    acceptLanguage: request.headers.get("accept-language"),
  });
  requestHeaders.set(DOCUMENT_LANGUAGE_HEADER, documentLanguage.language);
  requestHeaders.set(DOCUMENT_LANGUAGE_SOURCE_HEADER, documentLanguage.source);
  // UI-001. The theme travels the same way the document language does, and for
  // the same reason: the root layout needs it before it renders `<html>`.
  //
  // Only on dynamic routes. A static marketing response is prerendered once
  // and served from a public cache, so rendering one visitor's theme into it
  // would hand that theme to everyone sharing the cache entry. Those routes
  // get the media query from the stylesheet and, for an explicit choice that
  // contradicts the OS, the pre-paint bootstrap in components/ThemeBootstrap.
  if (!isStaticMarketingRequest) {
    const theme = resolveThemePreference({
      cookie: request.cookies.get(THEME_COOKIE_NAME)?.value,
    });
    requestHeaders.set(THEME_HEADER, theme);
  }
  if (nonce) requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(policyHeader, csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  if (isStaticMarketingRequest) {
    response.headers.set(
      "Cache-Control",
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
    );
  }
  const reportUrl = new URL(
    "/api/security/csp-report",
    getPublicReportOrigin()
  ).toString();
  response.headers.set(policyHeader, csp);
  response.headers.set(
    "Report-To",
    JSON.stringify({
      group: "csp-endpoint",
      max_age: 10886400,
      endpoints: [
        {
          url: reportUrl,
        },
      ],
    })
  );
  return response;
}

export const config = {
  // Deliberately unconditional. A `missing:` clause here would let any caller
  // skip the proxy - and therefore the host allowlist, the Cloudflare
  // origin-secret check, the mutation-origin (CSRF) check and CSP delivery - by
  // sending a single request header. Prefetch requests are cheap-pathed inside
  // proxy() instead, after those checks have run.
  matcher: [
    "/((?!_next/static|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
