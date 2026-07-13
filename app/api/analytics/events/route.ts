export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { getTrustedClientIp } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import { analyticsClientEventSchema } from "@/lib/productAnalyticsShared";
import {
  analyticsCountryFromHeaders,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";

const singletonEvents = new Set([
  "first_response_completed",
  "signup_completed",
  "return_day_1",
  "return_day_7",
]);

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const subject = userId || `anonymous:${getTrustedClientIp(req)}`;
    await consumeApiRateLimit(req, subject, "product-analytics-event", {
      minute: 120,
      day: 10_000,
    });
    const body = await readLimitedJson(
      req,
      8 * 1024,
      analyticsClientEventSchema
    );
    const user = userId
      ? await prisma.user.findUnique({
          where: { id: userId },
          select: { plan: true },
        })
      : null;
    const trustedCountry = analyticsCountryFromHeaders(req.headers);
    const occurredAtCandidate = new Date(body.occurred_at);
    const now = new Date();
    const occurredAt =
      occurredAtCandidate.getTime() <= now.getTime() + 5 * 60 * 1000 &&
      occurredAtCandidate.getTime() >= now.getTime() - 72 * 60 * 60 * 1000
        ? occurredAtCandidate
        : now;
    const actorKey = userId || body.client_id;
    const dedupeKey = singletonEvents.has(body.event_name)
      ? `singleton:${body.event_name}:${actorKey}`
      : `client:${body.event_id}`;

    await recordProductAnalyticsEvent({
      eventName: body.event_name,
      source: "client",
      userId,
      attribution: {
        client_id: body.client_id,
        session_id: body.session_id,
        utm_source: body.utm_source,
        utm_medium: body.utm_medium,
        utm_campaign: body.utm_campaign,
        language: body.language,
        country: trustedCountry === "ZZ" ? body.country : trustedCountry,
      },
      modelCount: body.model_count,
      plan: user?.plan || "Guest",
      properties: body.properties,
      occurredAt,
      dedupeKey,
    });

    return new NextResponse(null, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Product analytics event failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Analytics event was not recorded." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
