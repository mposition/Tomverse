export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  normalizeAnalyticsCountry,
  resolveAnalyticsConsentPolicy,
} from "@/lib/analyticsConsentPolicy";

const requestCountry = (headers: Headers) =>
  normalizeAnalyticsCountry(
    headers.get("cf-ipcountry") || headers.get("x-vercel-ip-country")
  );

export async function GET(req: Request) {
  const policy = resolveAnalyticsConsentPolicy(
    requestCountry(req.headers),
    process.env.ANALYTICS_DEFAULT_ENABLED_COUNTRIES
  );

  return NextResponse.json(policy, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Vary: "CF-IPCountry, X-Vercel-IP-Country",
    },
  });
}

