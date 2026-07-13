import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  analyticsAttributionSchema,
  analyticsPropertiesSchema,
  normalizeAnalyticsPlan,
  type AnalyticsAttribution,
  type ProductAnalyticsEventName,
  type ProductAnalyticsProperties,
} from "@/lib/productAnalyticsShared";

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

const sendGa4ServerEvent = async (
  input: RecordProductAnalyticsEventInput
) => {
  const measurementId = ga4MeasurementId();
  const apiSecret = process.env.GA4_API_SECRET?.trim();
  if (!measurementId || !apiSecret) return;

  const url = new URL("https://region1.google-analytics.com/mp/collect");
  url.searchParams.set("measurement_id", measurementId);
  url.searchParams.set("api_secret", apiSecret);
  const properties = analyticsPropertiesSchema.parse(input.properties || {});
  const sessionId = Number(input.attribution.session_id);
  const country = input.attribution.country === "ZZ"
    ? undefined
    : { country_id: input.attribution.country };

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
      events: [
        {
          name: input.eventName,
          params: {
            utm_source: input.attribution.utm_source,
            utm_medium: input.attribution.utm_medium,
            utm_campaign: input.attribution.utm_campaign,
            language: input.attribution.language,
            country: input.attribution.country,
            model_count: Math.max(0, Math.min(3, input.modelCount)),
            plan: normalizeAnalyticsPlan(input.plan),
            session_id: sessionId,
            engagement_time_msec: 100,
            ...properties,
          },
        },
      ],
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

export async function recordProductAnalyticsEvent(
  input: RecordProductAnalyticsEventInput
) {
  const properties = analyticsPropertiesSchema.parse(input.properties || {});
  const occurredAt = input.occurredAt || new Date();

  try {
    await prisma.productAnalyticsEvent.create({
      data: {
        dedupeKey: privateDigest("dedupe", input.dedupeKey),
        eventName: input.eventName,
        source: input.source,
        userId: input.userId || null,
        anonymousIdHash: privateDigest(
          "client",
          input.attribution.client_id
        ),
        sessionIdHash: privateDigest(
          "session",
          input.attribution.session_id
        ),
        utmSource: input.attribution.utm_source,
        utmMedium: input.attribution.utm_medium,
        utmCampaign: input.attribution.utm_campaign,
        language: input.attribution.language,
        country: input.attribution.country,
        modelCount: Math.max(0, Math.min(3, Math.trunc(input.modelCount))),
        plan: normalizeAnalyticsPlan(input.plan),
        properties: properties as Prisma.InputJsonValue,
        occurredAt,
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") return false;
    throw error;
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

export const analyticsCountryFromHeaders = (headers: Headers) => {
  const candidate = headers.get("cf-ipcountry")?.trim().toUpperCase();
  return candidate && /^[A-Z]{2}$/.test(candidate) ? candidate : "ZZ";
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
