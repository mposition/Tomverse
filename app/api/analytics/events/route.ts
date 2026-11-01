export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { after, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import { analyticsClientEventSchema } from "@/lib/productAnalyticsShared";
import {
  analyticsCountryFromHeaders,
  findLatestMarketingTouch,
  recordProductAnalyticsEvent,
  repairLateMarketingTouchSnapshots,
} from "@/lib/productAnalyticsServer";
import {
  MARKETING_TOUCH_EVENT,
  MARKETING_TOUCH_EVIDENCE,
  marketingTouchSnapshot,
  shouldSnapshotMarketingTouch,
  stripServerOnlyTouchProperties,
} from "@/lib/marketingTouchCore";
import {
  databaseErrorMetadata,
  isRetryableDatabaseError,
} from "@/lib/databaseError";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

const singletonEvents = new Set([
  "first_response_completed",
  "signup_completed",
  "return_day_1",
  "return_day_7",
  "return_day_30",
]);

export async function POST(req: Request) {
  const traceId = randomUUID();
  let stage = "session";
  let eventName: string | null = null;
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const subject = userId || `anonymous:${getAnonymousClientKey(req)}`;
    stage = "rate-limit";
    await consumeApiRateLimit(req, subject, "product-analytics-event", {
      minute: 120,
      day: 10_000,
    });
    stage = "payload";
    const body = await readLimitedJson(
      req,
      8 * 1024,
      analyticsClientEventSchema
    );
    eventName = body.event_name;
    stage = "user-plan";
    const user = userId
      ? await prisma.user.findUnique({
          where: { id: userId },
          select: { plan: true },
        })
      : null;
    const trustedCountry = analyticsCountryFromHeaders(req.headers);
    const occurredAtCandidate = new Date(body.occurred_at);
    const now = new Date();
    const isMarketingTouch = body.event_name === MARKETING_TOUCH_EVENT;
    // A marketing touch is timed by the server's receipt and nothing else
    // (docs/policy/marketing-automation.md §10.1): its whole evidence value is
    // "client-observed, server-timed", and a client clock would make it
    // neither.
    const occurredAt =
      !isMarketingTouch &&
      occurredAtCandidate.getTime() <= now.getTime() + 5 * 60 * 1000 &&
      occurredAtCandidate.getTime() >= now.getTime() - 72 * 60 * 60 * 1000
        ? occurredAtCandidate
        : now;
    const actorKey = userId || body.client_id;
    const dedupeKey = singletonEvents.has(body.event_name)
      ? `singleton:${body.event_name}:${actorKey}`
      : `client:${body.event_id}`;

    // Evidence and attribution are the server's to write. Whatever a client
    // sent under those keys is dropped first, then the server sets its own.
    let properties = stripServerOnlyTouchProperties(body.properties);
    if (isMarketingTouch) {
      properties = { ...properties, touch_evidence: MARKETING_TOUCH_EVIDENCE };
    } else if (shouldSnapshotMarketingTouch(body.event_name, userId)) {
      stage = "touch-attribution";
      const touch = await findLatestMarketingTouch({
        clientId: body.client_id,
        userId,
        receivedAt: now,
      });
      properties = { ...properties, ...marketingTouchSnapshot(touch, now) };
    }

    stage = "event-write";
    const recorded = await recordProductAnalyticsEvent({
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
      properties,
      occurredAt,
      dedupeKey,
    });

    // A touch stored just after the conversion it belongs to finishes that
    // conversion's snapshot (lib/marketingTouchCore.ts,
    // lateMarketingTouchRepair). The touch itself is already recorded, so a
    // failure here is reported and the touch still answered as accepted.
    if (isMarketingTouch && recorded) {
      stage = "touch-repair";
      await repairLateMarketingTouchSnapshots({
        clientId: body.client_id,
        userId,
        touch: {
          utmSource: body.utm_source,
          utmMedium: body.utm_medium,
          utmCampaign: body.utm_campaign,
          utmContent: properties.utm_content ?? null,
          occurredAt,
        },
        touchObservedAt: occurredAtCandidate,
      }).catch((error: unknown) => {
        console.warn("Marketing touch snapshot repair failed.", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          traceId,
        });
      });
    }

    return new NextResponse(null, {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
        "X-Tomverse-Trace-Id": traceId,
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const diagnostic = databaseErrorMetadata(error);
    const retryable = isRetryableDatabaseError(error);
    after(() => reportOperationalIncident({
      code: retryable
        ? "PRODUCT_ANALYTICS_DATABASE_TRANSIENT"
        : "PRODUCT_ANALYTICS_EVENT_FAILED",
      title: "Product analytics event failed",
      error: diagnostic.message,
      severity: retryable ? "warning" : "error",
      context: {
        component: "product-analytics",
        route: "/api/analytics/events",
        stage,
        eventName: eventName || "unknown",
        traceId,
        retryable,
        errorName: diagnostic.errorName,
        errorCode: diagnostic.errorCode || "none",
        driverKind: diagnostic.driverKind || "none",
        driverCode: diagnostic.driverCode || "none",
      },
    }).catch(() => undefined));
    console.error("Product analytics event failed.", {
      ...diagnostic,
      stage,
      eventName: eventName || "unknown",
      traceId,
      retryable,
    });
    return NextResponse.json(
      {
        error: "Analytics event was not recorded.",
        code: retryable
          ? "ANALYTICS_DATABASE_TEMPORARILY_UNAVAILABLE"
          : "ANALYTICS_EVENT_FAILED",
        traceId,
      },
      {
        status: retryable ? 503 : 500,
        headers: {
          "Cache-Control": "no-store",
          ...(retryable ? { "Retry-After": "2" } : {}),
          "X-Tomverse-Trace-Id": traceId,
        },
      }
    );
  }
}
