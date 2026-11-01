import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeAnalyticsCountry } from "@/lib/analyticsConsentPolicy";
import {
  analyticsAttributionSchema,
  analyticsPropertiesSchema,
  ga4DebugEventParams,
  ga4EcommerceEventForProductEvent,
  normalizeAnalyticsPlan,
  shouldSendCustomProductEventToGa4,
  type AnalyticsAttribution,
  type ProductAnalyticsEventName,
  type ProductAnalyticsProperties,
} from "@/lib/productAnalyticsShared";
import { localeMarketingAnalyticsProperties } from "@/lib/localeLaunchPolicy";
import {
  MARKETING_TOUCH_EVENT,
  MARKETING_TOUCH_LATE_ARRIVAL_MS,
  lateMarketingTouchRepair,
  marketingTouchSnapshot,
  marketingTouchWindow,
  shouldSnapshotMarketingTouch,
  type MarketingTouchRow,
} from "@/lib/marketingTouchCore";
import {
  isRetryableDatabaseError,
  isUniqueConstraintDatabaseError,
} from "@/lib/databaseError";

type RecordProductAnalyticsEventInput = {
  eventName: ProductAnalyticsEventName;
  source: "client" | "server";
  userId?: string | null;
  attribution: AnalyticsAttribution;
  modelCount: number;
  plan: string;
  properties?: ProductAnalyticsProperties;
  occurredAt?: Date;
  dedupeKey: string;
  sendToGa4?: boolean;
};

const analyticsSecret = () =>
  process.env.NEXTAUTH_SECRET || "tomverse-development-analytics";

const privateDigest = (scope: string, value: string) =>
  createHmac("sha256", analyticsSecret())
    .update(`${scope}:${value}`)
    .digest("hex");

const syntheticClientId = (value: string) => {
  const digest = createHash("sha256").update(value).digest();
  return `${digest.readUInt32BE(0) || 1}.${digest.readUInt32BE(4) || 1}`;
};

const ga4MeasurementId = () => {
  const value = process.env.GA4_MEASUREMENT_ID?.trim();
  return value && /^G-[A-Z0-9]+$/.test(value) ? value : null;
};

const analyticsPropertiesForInput = (
  input: RecordProductAnalyticsEventInput
) =>
  analyticsPropertiesSchema.parse({
    ...(input.properties || {}),
    ...localeMarketingAnalyticsProperties(input.attribution.language),
  });

const sendGa4ServerEvent = async (
  input: RecordProductAnalyticsEventInput
) => {
  const measurementId = ga4MeasurementId();
  const apiSecret = process.env.GA4_API_SECRET?.trim();
  if (!measurementId || !apiSecret) return;

  const url = new URL("https://region1.google-analytics.com/mp/collect");
  url.searchParams.set("measurement_id", measurementId);
  url.searchParams.set("api_secret", apiSecret);
  const properties = analyticsPropertiesForInput(input);
  const sessionId = Number(input.attribution.session_id);
  const debugParams = ga4DebugEventParams(
    process.env.NEXT_PUBLIC_GA4_DEBUG_MODE
  );
  const country = input.attribution.country === "ZZ"
    ? undefined
    : { country_id: input.attribution.country };
  const commonParams = {
    utm_source: input.attribution.utm_source,
    utm_medium: input.attribution.utm_medium,
    utm_campaign: input.attribution.utm_campaign,
    language: input.attribution.language,
    country: input.attribution.country,
    model_count: Math.max(0, Math.min(3, input.modelCount)),
    plan: normalizeAnalyticsPlan(input.plan),
    session_id: sessionId,
    engagement_time_msec: 100,
    ...debugParams,
  };
  const ecommerceEvent = ga4EcommerceEventForProductEvent(
    input.eventName,
    properties
  );
  const ga4Events = [
    ...(shouldSendCustomProductEventToGa4(input.eventName)
      ? [
          {
            name: input.eventName,
            params: {
              ...commonParams,
              ...properties,
            },
          },
        ]
      : []),
    ...(ecommerceEvent
      ? [
          {
            name: ecommerceEvent.name,
            params: {
              ...commonParams,
              ...ecommerceEvent.params,
            },
          },
        ]
      : []),
  ];
  if (ga4Events.length === 0) return;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:
        input.attribution.client_id ||
        syntheticClientId(input.userId || input.dedupeKey),
      consent: {
        ad_user_data: "DENIED",
        ad_personalization: "DENIED",
      },
      ...(country ? { user_location: country } : {}),
      events: ga4Events,
      validation_behavior: "ENFORCE_RECOMMENDATIONS",
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    console.warn("GA4 Measurement Protocol event was not accepted.", {
      eventName: input.eventName,
      status: response.status,
    });
  }
};

const analyticsEventData = (input: RecordProductAnalyticsEventInput) => ({
  dedupeKey: privateDigest("dedupe", input.dedupeKey),
  eventName: input.eventName,
  source: input.source,
  userId: input.userId || null,
  anonymousIdHash: privateDigest("client", input.attribution.client_id),
  sessionIdHash: privateDigest("session", input.attribution.session_id),
  utmSource: input.attribution.utm_source,
  utmMedium: input.attribution.utm_medium,
  utmCampaign: input.attribution.utm_campaign,
  language: input.attribution.language,
  country: input.attribution.country,
  modelCount: Math.max(0, Math.min(3, Math.trunc(input.modelCount))),
  plan: normalizeAnalyticsPlan(input.plan),
  properties: analyticsPropertiesForInput(input) as Prisma.InputJsonValue,
  occurredAt: input.occurredAt || new Date(),
});

export async function recordProductAnalyticsEvent(
  input: RecordProductAnalyticsEventInput
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await prisma.productAnalyticsEvent.create({
        data: analyticsEventData(input),
      });
      break;
    } catch (error) {
      if (isUniqueConstraintDatabaseError(error)) return false;
      if (attempt === 0 && isRetryableDatabaseError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        continue;
      }
      throw error;
    }
  }

  if (input.sendToGa4) {
    await sendGa4ServerEvent(input).catch((error) => {
      console.warn("GA4 Measurement Protocol delivery failed.", {
        eventName: input.eventName,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }
  return true;
}

/** The client a marketing lookup or repair runs on: the shared one, or a transaction. */
type AnalyticsEventDb = Pick<Prisma.TransactionClient, "productAnalyticsEvent">;

/**
 * The last `marketing_touch` the same browser -- or, once signed in, the same
 * account -- sent in the seven days before `receivedAt` (§10.1). Matched on the
 * keyed digest of the client id, the same one the event rows store, so the raw
 * id is never compared or kept.
 */
export async function findLatestMarketingTouch(input: {
  clientId: string;
  userId: string | null;
  receivedAt: Date;
  db?: AnalyticsEventDb;
}): Promise<MarketingTouchRow | null> {
  const anonymousIdHash = privateDigest("client", input.clientId);
  const row = await (input.db ?? prisma).productAnalyticsEvent.findFirst({
    where: {
      eventName: MARKETING_TOUCH_EVENT,
      occurredAt: marketingTouchWindow(input.receivedAt),
      OR: [
        { anonymousIdHash },
        ...(input.userId ? [{ userId: input.userId }] : []),
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: {
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      properties: true,
      occurredAt: true,
    },
  });
  if (!row) return null;
  const content =
    row.properties &&
    typeof row.properties === "object" &&
    !Array.isArray(row.properties)
      ? (row.properties as Record<string, unknown>).utm_content
      : undefined;
  return {
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    utmContent: typeof content === "string" && content ? content : null,
    occurredAt: row.occurredAt,
  };
}

/**
 * Finishes the snapshot of a conversion a just-stored touch belongs to
 * (`lateMarketingTouchRepair`): the same browser's or account's sign-up or
 * guest first answer received within thirty seconds of the touch. Returns how
 * many it repaired.
 */
export async function repairLateMarketingTouchSnapshots(input: {
  clientId: string;
  userId: string | null;
  touch: MarketingTouchRow;
  touchObservedAt: Date;
  db?: AnalyticsEventDb;
}) {
  const db = input.db ?? prisma;
  const anonymousIdHash = privateDigest("client", input.clientId);
  const receivedAt = input.touch.occurredAt.getTime();
  const rows = await db.productAnalyticsEvent.findMany({
    where: {
      eventName: { in: ["signup_completed", "first_response_completed"] },
      createdAt: {
        gte: new Date(receivedAt - MARKETING_TOUCH_LATE_ARRIVAL_MS),
        lte: new Date(receivedAt + MARKETING_TOUCH_LATE_ARRIVAL_MS),
      },
      OR: [
        { anonymousIdHash },
        ...(input.userId ? [{ userId: input.userId }] : []),
      ],
    },
    select: {
      id: true,
      eventName: true,
      userId: true,
      occurredAt: true,
      createdAt: true,
      properties: true,
    },
    take: 10,
  });
  let repaired = 0;
  for (const row of rows) {
    const properties = lateMarketingTouchRepair({
      conversion: {
        ...row,
        eventName: row.eventName as ProductAnalyticsEventName,
      },
      touch: input.touch,
      touchObservedAt: input.touchObservedAt,
    });
    if (!properties) continue;
    await db.productAnalyticsEvent.update({
      where: { id: row.id },
      data: {
        properties: analyticsPropertiesSchema.parse(
          properties
        ) as Prisma.InputJsonValue,
      },
    });
    repaired += 1;
  }
  return repaired;
}

/**
 * Records an event, putting one browser's touches and conversions in a single
 * order (§10.1).
 *
 * A touch and a conversion from the same browser, sent together when consent
 * releases the queue, can interleave: the conversion looks for a touch and
 * finds none, the touch is stored and looks for a conversion to finish and
 * finds none, and then the conversion is stored -- unattributed for good. So
 * both take the same per-browser transaction lock (keyed on the stored digest
 * of the client id, never the raw id) around their whole read-then-write: a
 * conversion's lookup and insert, a touch's insert and repair. Whichever goes
 * second sees the first committed. Two touches finishing the same conversion
 * are serialised the same way, so the repair always reads the latest snapshot.
 *
 * A conversion matched through the account rather than the browser is not
 * serialised against a touch from another browser; that pairing is the rare
 * one and is left to the ordinary lookup.
 *
 * Every other event is recorded as before. Returns whether a row was written
 * (false for a duplicate).
 */
export async function recordOrderedAnalyticsEvent(
  input: RecordProductAnalyticsEventInput & {
    receivedAt: Date;
    touchObservedAt: Date;
  }
): Promise<boolean> {
  const userId = input.userId || null;
  const isTouch = input.eventName === MARKETING_TOUCH_EVENT;
  const snapshot = shouldSnapshotMarketingTouch(input.eventName, userId);
  if (!isTouch && !snapshot) return recordProductAnalyticsEvent(input);

  const clientId = input.attribution.client_id;
  const lockKey = `marketing-touch:${privateDigest("client", clientId)}`;
  return prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    let properties = input.properties || {};
    if (snapshot) {
      const touch = await findLatestMarketingTouch({
        clientId,
        userId,
        receivedAt: input.receivedAt,
        db,
      });
      properties = {
        ...properties,
        ...marketingTouchSnapshot(touch, input.receivedAt),
      };
    }
    const event = { ...input, properties };
    // ON CONFLICT DO NOTHING rather than catching a unique violation: an error
    // would abort the transaction the repair below still needs.
    const { count } = await db.productAnalyticsEvent.createMany({
      data: [analyticsEventData(event)],
      skipDuplicates: true,
    });
    if (count !== 1) return false;
    if (isTouch) {
      await repairLateMarketingTouchSnapshots({
        clientId,
        userId,
        touch: {
          utmSource: input.attribution.utm_source,
          utmMedium: input.attribution.utm_medium,
          utmCampaign: input.attribution.utm_campaign,
          utmContent: properties.utm_content ?? null,
          occurredAt: input.occurredAt || input.receivedAt,
        },
        touchObservedAt: input.touchObservedAt,
        db,
      });
    }
    return true;
  });
}

export const analyticsCountryFromHeaders = (headers: Headers) => {
  return normalizeAnalyticsCountry(
    headers.get("cf-ipcountry") || headers.get("x-vercel-ip-country")
  );
};

export const analyticsAttributionFromMetadata = (
  metadata: Record<string, string> | null | undefined
) => {
  const parsed = analyticsAttributionSchema.safeParse({
    client_id: metadata?.analyticsClientId,
    session_id: metadata?.analyticsSessionId,
    utm_source: metadata?.analyticsUtmSource,
    utm_medium: metadata?.analyticsUtmMedium,
    utm_campaign: metadata?.analyticsUtmCampaign,
    language: metadata?.analyticsLanguage,
    country: metadata?.analyticsCountry,
  });
  return parsed.success ? parsed.data : null;
};
