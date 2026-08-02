export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPublicAppSettings } from "@/lib/appSettings";
import { consumePublicReadBudget } from "@/lib/publicReadRateLimit";
import { readPublicSnapshot } from "@/lib/publicSnapshotCache";

/**
 * SEC-012. Unauthenticated, and previously one database query per request with
 * nothing in front of it. The answer is identical for every caller, so it is
 * served from a short-lived shared snapshot with an ETag; see
 * `lib/publicSnapshotCache.ts`.
 */
export async function GET(request: Request) {
  const budget = consumePublicReadBudget(request, "app-settings");
  if (!budget.allowed) {
    return NextResponse.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: {
          "Retry-After": String(budget.retryAfter),
          "Cache-Control": "no-store",
        },
      }
    );
  }

  try {
    const { value: settings, etag } = await readPublicSnapshot(
      "app-settings",
      getPublicAppSettings
    );
    const headers = {
      // Revalidate every time, but let the ETag answer with no body. Kept
      // private rather than public: these are operational flags, and a shared
      // CDN cache would outlive an incident-time flip of `aiChatEnabled`.
      "Cache-Control": "private, no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };

    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json(settings, { headers });
  } catch (error) {
    console.error("Failed to load app settings:", error);
    return NextResponse.json(
      { error: "Failed to load app settings." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
