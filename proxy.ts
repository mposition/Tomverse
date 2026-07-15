import { NextRequest, NextResponse } from "next/server";
import { createStaticMarketingCsp, createStrictCsp } from "@/lib/csp";
import { isStaticMarketingPathname } from "@/lib/marketingRoutes";
import { getStaticMarketingCspHashes } from "@/lib/staticMarketingCsp";
import {
  getPublicReportOrigin,
  hasRequiredOriginSecret,
  isAllowedRequestHost,
} from "@/lib/originProtection";

const blockedOriginResponse = () =>
  new NextResponse("Misdirected Request", {
    status: 421,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname === "/api/health" ||
    request.nextUrl.pathname === "/api/ready"
  ) {
    return NextResponse.next();
  }

  if (
    !isAllowedRequestHost(request.headers.get("host")) ||
    !hasRequiredOriginSecret(request.headers)
  ) {
    return blockedOriginResponse();
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
  matcher: [
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
