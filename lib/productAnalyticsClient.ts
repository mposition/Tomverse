"use client";

import {
  analyticsClientEventSchema,
  analyticsPropertiesSchema,
  type AnalyticsAttribution,
  type ProductAnalyticsEventName,
  type ProductAnalyticsProperties,
} from "@/lib/productAnalyticsShared";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const CONTEXT_STORAGE_KEY = "tomverse_analytics_context_v1";
const CONSENT_STORAGE_KEY = "tomverse_analytics_consent_v1";
const SIGNUP_STORAGE_KEY = "tomverse_analytics_signup_v1";
const SESSION_STORAGE_KEY = "tomverse_analytics_session_v1";
const MAX_PENDING_EVENTS = 100;
const ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type AnalyticsRuntime = {
  attribution: AnalyticsAttribution;
  measurementId: string | null;
  plan: "Guest" | "Free" | "Pro" | "Max";
  firstSeenAt: string;
  capturedAt: string;
  sentOnce: Set<string>;
};

type EventIntent = {
  eventId: string;
  eventName: ProductAnalyticsEventName;
  occurredAt: string;
  modelCount: number;
  properties: ProductAnalyticsProperties;
  onceKey?: string;
};

type StoredContext = {
  clientId: string;
  firstSeenAt: string;
  capturedAt: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  sentOnce: string[];
};

let runtime: AnalyticsRuntime | null = null;
let pendingEvents: EventIntent[] = [];
const pendingOnceKeys = new Set<string>();

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );

const limited = (value: string | null, fallback: string) => {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 100) : fallback;
};

const readStoredContext = (): StoredContext | null => {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CONTEXT_STORAGE_KEY) || "null"
    ) as Partial<StoredContext> | null;
    if (!parsed || !isUuid(parsed.clientId)) return null;
    if (
      typeof parsed.firstSeenAt !== "string" ||
      typeof parsed.capturedAt !== "string" ||
      typeof parsed.utmSource !== "string" ||
      typeof parsed.utmMedium !== "string" ||
      typeof parsed.utmCampaign !== "string"
    ) {
      return null;
    }
    return {
      clientId: parsed.clientId,
      firstSeenAt: parsed.firstSeenAt,
      capturedAt: parsed.capturedAt,
      utmSource: parsed.utmSource.slice(0, 100),
      utmMedium: parsed.utmMedium.slice(0, 100),
      utmCampaign: parsed.utmCampaign.slice(0, 100),
      sentOnce: Array.isArray(parsed.sentOnce)
        ? parsed.sentOnce.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return null;
  }
};

const writeStoredContext = (nextRuntime: AnalyticsRuntime) => {
  const stored: StoredContext = {
    clientId: nextRuntime.attribution.client_id,
    firstSeenAt: nextRuntime.firstSeenAt,
    capturedAt: nextRuntime.capturedAt,
    utmSource: nextRuntime.attribution.utm_source,
    utmMedium: nextRuntime.attribution.utm_medium,
    utmCampaign: nextRuntime.attribution.utm_campaign,
    sentOnce: Array.from(nextRuntime.sentOnce).slice(-100),
  };
  window.localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(stored));
};

const currentUtm = () => {
  const params = new URLSearchParams(window.location.search);
  const hasUtm = ["utm_source", "utm_medium", "utm_campaign"].some((key) =>
    params.has(key)
  );
  if (!hasUtm) return null;
  return {
    utmSource: limited(params.get("utm_source"), "(direct)"),
    utmMedium: limited(params.get("utm_medium"), "(none)"),
    utmCampaign: limited(params.get("utm_campaign"), "(not set)"),
  };
};

const sessionId = () => {
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing && /^\d{10,16}$/.test(existing)) return existing;
  const created = String(Date.now());
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
  return created;
};

const sendIntent = (intent: EventIntent) => {
  if (!runtime) return;
  const payload = analyticsClientEventSchema.parse({
    event_id: intent.eventId,
    event_name: intent.eventName,
    occurred_at: intent.occurredAt,
    model_count: Math.max(0, Math.min(3, Math.trunc(intent.modelCount))),
    properties: intent.properties,
    ...runtime.attribution,
  });

  window.gtag?.("event", intent.eventName, {
    utm_source: payload.utm_source,
    utm_medium: payload.utm_medium,
    utm_campaign: payload.utm_campaign,
    language: payload.language,
    country: payload.country,
    model_count: payload.model_count,
    plan: runtime.plan,
    session_id: Number(payload.session_id),
    ...payload.properties,
  });

  void fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
    cache: "no-store",
  }).catch(() => undefined);
};

export const analyticsConsent = () =>
  typeof window !== "undefined"
    ? window.localStorage.getItem(CONSENT_STORAGE_KEY)
    : null;

export const setAnalyticsConsent = (value: "accepted" | "declined") => {
  window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
};

export const configureAnalyticsClient = ({
  country,
  language,
  measurementId,
  plan,
}: {
  country: string;
  language: AnalyticsAttribution["language"];
  measurementId: string | null;
  plan: AnalyticsRuntime["plan"];
}) => {
  const now = new Date();
  const stored = readStoredContext();
  const storedCapturedAt = stored ? new Date(stored.capturedAt).getTime() : 0;
  const storedAttributionIsFresh =
    storedCapturedAt > 0 && now.getTime() - storedCapturedAt <= ATTRIBUTION_TTL_MS;
  const urlUtm = currentUtm();
  const attribution = urlUtm ||
    (stored && storedAttributionIsFresh
      ? {
          utmSource: stored.utmSource,
          utmMedium: stored.utmMedium,
          utmCampaign: stored.utmCampaign,
        }
      : {
          utmSource: "(direct)",
          utmMedium: "(none)",
          utmCampaign: "(not set)",
        });

  runtime = {
    attribution: {
      client_id: stored?.clientId || crypto.randomUUID(),
      session_id: sessionId(),
      utm_source: attribution.utmSource,
      utm_medium: attribution.utmMedium,
      utm_campaign: attribution.utmCampaign,
      language,
      country: /^[A-Z]{2}$/.test(country) ? country : "ZZ",
    },
    measurementId,
    plan,
    firstSeenAt: stored?.firstSeenAt || now.toISOString(),
    capturedAt:
      urlUtm || !storedAttributionIsFresh
        ? now.toISOString()
        : stored?.capturedAt || now.toISOString(),
    sentOnce: new Set(stored?.sentOnce || []),
  };

  if (measurementId) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || ((...args: unknown[]) => window.dataLayer?.push(args));
    window.gtag("consent", "default", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    window.gtag("js", now);
    window.gtag("config", measurementId, {
      send_page_view: true,
      client_id: runtime.attribution.client_id,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  }

  const queued = pendingEvents;
  pendingEvents = [];
  for (const intent of queued) {
    if (intent.onceKey && runtime.sentOnce.has(intent.onceKey)) continue;
    if (intent.onceKey) runtime.sentOnce.add(intent.onceKey);
    sendIntent(intent);
  }
  pendingOnceKeys.clear();
  writeStoredContext(runtime);
  return runtime;
};

export const disableAnalyticsClient = () => {
  window.gtag?.("consent", "update", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  runtime = null;
  pendingEvents = [];
  pendingOnceKeys.clear();
  window.localStorage.removeItem(CONTEXT_STORAGE_KEY);
  window.localStorage.removeItem(SIGNUP_STORAGE_KEY);
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name === "_ga" || name?.startsWith("_ga_")) {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
    }
  }
};

export function trackProductEvent(
  eventName: ProductAnalyticsEventName,
  modelCount = 0,
  properties: ProductAnalyticsProperties = {}
) {
  const parsedProperties = analyticsPropertiesSchema.safeParse(properties);
  if (!parsedProperties.success) return;
  const intent: EventIntent = {
    eventId: crypto.randomUUID(),
    eventName,
    occurredAt: new Date().toISOString(),
    modelCount,
    properties: parsedProperties.data,
  };
  if (!runtime) {
    pendingEvents = [...pendingEvents.slice(-(MAX_PENDING_EVENTS - 1)), intent];
    return;
  }
  sendIntent(intent);
}

export function trackProductEventOnce(
  onceKey: string,
  eventName: ProductAnalyticsEventName,
  modelCount = 0,
  properties: ProductAnalyticsProperties = {}
) {
  if (runtime?.sentOnce.has(onceKey) || pendingOnceKeys.has(onceKey)) return;
  const parsedProperties = analyticsPropertiesSchema.safeParse(properties);
  if (!parsedProperties.success) return;
  const intent: EventIntent = {
    eventId: crypto.randomUUID(),
    eventName,
    occurredAt: new Date().toISOString(),
    modelCount,
    properties: parsedProperties.data,
    onceKey,
  };
  if (!runtime) {
    pendingOnceKeys.add(onceKey);
    pendingEvents = [...pendingEvents.slice(-(MAX_PENDING_EVENTS - 1)), intent];
    return;
  }
  runtime.sentOnce.add(onceKey);
  writeStoredContext(runtime);
  sendIntent(intent);
}

export const markSignupStarted = (method: string) => {
  if (!runtime) return;
  const normalizedMethod = method.trim().slice(0, 32) || "unknown";
  window.localStorage.setItem(
    SIGNUP_STORAGE_KEY,
    JSON.stringify({ method: normalizedMethod, startedAt: new Date().toISOString() })
  );
  trackProductEvent("signup_started", 0, { method: normalizedMethod });
};

export const consumeSignupStarted = () => {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(SIGNUP_STORAGE_KEY) || "null"
    ) as { method?: unknown; startedAt?: unknown } | null;
    window.localStorage.removeItem(SIGNUP_STORAGE_KEY);
    if (
      !parsed ||
      typeof parsed.method !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return { method: parsed.method.slice(0, 32), startedAt: parsed.startedAt };
  } catch {
    window.localStorage.removeItem(SIGNUP_STORAGE_KEY);
    return null;
  }
};

export const getAnalyticsAttributionSnapshot = () => runtime?.attribution || null;
