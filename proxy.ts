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
  apiRouteChoosesOwnCaching,
  DEFAULT_API_CACHE_CONTROL,
  isApiPathname,
} from "@/lib/apiCacheControlPolicy";
import {
  hasValidMutationOrigin,
  requiresMutationOriginCheck,
} from "@/lib/requestOrigin";
import {
  isPreflightRequest,
  nativeAppCorsHeaders,
  nativeAppPreflightHeaders,
  varyWithOrigin,
} from "@/lib/nativeAppCors";
import {
  DOCUMENT_LANGUAGE_HEADER,
  DOCUMENT_LANGUAGE_SOURCE_HEADER,
  isSupportedDocumentLanguage,
  resolveDocumentLanguage,
} from "@/lib/documentLanguage";
import { verifyMobileAccessTokenString } from "@/lib/mobileAccessToken";
import { MOBILE_AUTH_ERROR_CODES, N1B_BEARER_ROUTES } from "@/lib/mobileAuthContract";
import {
  applyMobileIdentityHeaders,
  nativeBearerVerdict,
  stripInternalAuthHeaders,
} from "@/lib/nativeBearerGate";

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

/**
 * N1b's refusal. A presented bearer that does not verify.
 *
 * 401 and nothing else -- specifically not a fall-through to the cookie path,
 * which is section 5.1's fourth prohibition: "attach a broken bearer" must not
 * become "a cookie request with the CSRF check removed".
 *
 * One code for every failure. Which check a forged token tripped is a fact
 * about the token, and telling its holder is telling them which byte to fix.
 */
const blockedBearerResponse = () =>
  NextResponse.json(
    { ok: false, code: MOBILE_AUTH_ERROR_CODES.tokenInvalid },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );

/**
 * N1a. Make an API response readable by the Capacitor shell, and by nothing
 * else.
 *
 * Applied to every `/api/*` response after the host and origin-secret checks
 * have passed -- including the refusals. A native client that is told `403
 * INVALID_REQUEST_ORIGIN` can act on it; one that receives an opaque CORS
 * failure cannot tell a refusal from an outage.
 *
 * `Vary: Origin` goes on regardless of whether the origin matched, so a shared
 * cache cannot replay one origin's allowance to another. Decisions live in
 * `lib/nativeAppCors.ts`; this only carries them onto a response.
 */
const withNativeCors = <T extends NextResponse>(
  response: T,
  request: NextRequest
): T => {
  if (!request.nextUrl.pathname.startsWith("/api/")) return response;
  response.headers.set(
    "Vary",
    varyWithOrigin(response.headers.get("Vary"))
  );
  const cors = nativeAppCorsHeaders(request.headers.get("origin"));
  if (!cors) return response;
  for (const [key, value] of Object.entries(cors)) {
    response.headers.set(key, value);
  }
  return response;
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

  // Section 5.4, step 3 of the order. Unconditional, and before anything is
  // verified.
  //
  // Every downstream `NextResponse.next()` in this function forwards *these*
  // headers rather than the request's own, which is the point: overwriting the
  // namespace on success would leave a client's forgery intact on every branch
  // that writes nothing -- an unregistered route, a refusal, a prefetch.
  const requestHeaders = new Headers(request.headers);
  const forgedInternalHeaders = stripInternalAuthHeaders(requestHeaders);
  if (forgedInternalHeaders.length > 0) {
    // Names only. The values are attacker-controlled text, and what an operator
    // needs to know is that somebody tried.
    console.warn("Client sent internal auth headers", {
      pathname: request.nextUrl.pathname,
      headers: forgedInternalHeaders,
    });
  }

  // N1a. Answer a CORS preflight from the Capacitor shell here, because no
  // route does: there is not one `export async function OPTIONS` in the whole
  // of `app/api/`, so a preflight would otherwise reach a handler that answers
  // 405 with no CORS headers, and the browser would report the real request as
  // a network failure.
  //
  // Deliberately *after* the host and origin-secret checks and *before* the
  // mutation-origin check. After, because a preflight is not exempt from the
  // edge boundary. Before, only because `OPTIONS` is one of the safe methods
  // that check already skips -- this does not step around it, and the request
  // the preflight is asking about still has to face it.
  //
  // A preflight from any other origin gets no headers and falls through, which
  // is what makes a hostile origin's fetch fail in its own browser.
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    isPreflightRequest({
      method: request.method,
      accessControlRequestMethod: request.headers.get(
        "access-control-request-method"
      ),
    })
  ) {
    const preflight = nativeAppPreflightHeaders(request.headers.get("origin"));
    if (preflight) {
      return withNativeCors(
        new NextResponse(null, {
          status: 204,
          headers: { ...preflight, "Cache-Control": "no-store" },
        }),
        request
      );
    }
  }

  // Section 5.5, steps 5 and 6. The verifier has to run *before* the
  // mutation-origin check or N1b does not exist -- that ordering is the one
  // surviving reason the design rejected verifying only inside routes.
  //
  // `N1B_BEARER_ROUTES` is empty by approval (decision 13), so today every
  // verdict is `not_applicable` and this changes nothing about any request.
  // The order is what is being put in place; opening it is a separate act, one
  // route at a time, each with evidence that the route reads the bearer rather
  // than the cookie session.
  const bearer = nativeBearerVerdict({
    pathname: request.nextUrl.pathname,
    authorization: request.headers.get("authorization"),
    registeredRoutes: N1B_BEARER_ROUTES,
    verify: (token) => {
      const verdict = verifyMobileAccessTokenString(token);
      return verdict.ok
        ? { ok: true, identity: verdict.identity }
        : { ok: false, failure: verdict.failure };
    },
  });
  if (bearer.kind === "reject") {
    return withNativeCors(blockedBearerResponse(), request);
  }
  if (bearer.kind === "yes") {
    applyMobileIdentityHeaders(requestHeaders, bearer.identity);
  }

  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    // Replaced, not skipped: a verified bearer is not an ambient credential,
    // so the premise the check exists to defend does not hold for it. Every
    // other verdict -- including `no` and `not_applicable` -- still faces it.
    bearer.kind !== "yes" &&
    requiresMutationOriginCheck(request.method, request.nextUrl.pathname) &&
    !hasValidMutationOrigin(request)
  ) {
    // Unchanged. A native origin fails this exactly as it did before N1a --
    // `capacitor://localhost` is not an http(s) origin and `https://localhost`
    // is not an allowed host -- and nothing above consulted an `Authorization`
    // header to decide otherwise. Replacing this check for a *verified* bearer
    // identity is N1b, and N1b waits on the verifier that N2 builds.
    return withNativeCors(blockedMutationOriginResponse(request), request);
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
    // The stripped headers, not the request's own: a prefetch is the one early
    // return that reaches a route, so `NextResponse.next()` with no argument
    // here would forward a client-sent identity header untouched.
    return withNativeCors(
      NextResponse.next({ request: { headers: requestHeaders } }),
      request
    );
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
  // `requestHeaders` was built above, with the internal auth namespace already
  // stripped and, where the bearer verified, rewritten.
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
  } else if (
    isApiPathname(request.nextUrl.pathname) &&
    !apiRouteChoosesOwnCaching(request.nextUrl.pathname)
  ) {
    // Next attaches no Cache-Control to a route handler response, and a
    // response with none is heuristically cacheable by a shared cache. See
    // lib/apiCacheControlPolicy.ts for why this is set here, and why the
    // handful of routes that choose their own caching are listed rather than
    // detected: a header set in middleware overrides the route's own.
    response.headers.set("Cache-Control", DEFAULT_API_CACHE_CONTROL);
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
  return withNativeCors(response, request);
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
