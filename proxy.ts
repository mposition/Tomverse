import { NextRequest, NextResponse } from "next/server";
import { createStrictCsp } from "@/lib/csp";
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
    !isAllowedRequestHost(request.headers.get("host")) ||
    !hasRequiredOriginSecret(request.headers)
  ) {
    return blockedOriginResponse();
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const strictCsp = createStrictCsp(nonce);
  const enforce = process.env.CSP_MODE === "enforce";
  const policyHeader = enforce
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(policyHeader, strictCsp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  const reportUrl = new URL(
    "/api/security/csp-report",
    getPublicReportOrigin()
  ).toString();
  response.headers.set(policyHeader, strictCsp);
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
