"use client";

import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  PRODUCT_ANALYTICS_EVENT_NAMES,
  analyticsClientEventSchema,
  analyticsPropertiesSchema,
  ga4DebugEventParams,
  ga4EcommerceEventForProductEvent,
  shouldSendCustomProductEventToGa4,
  type AnalyticsAttribution,
  type ProductAnalyticsEventName,
  type ProductAnalyticsProperties,
} from "@/lib/productAnalyticsShared";
import { localeMarketingAnalyticsProperties } from "@/lib/localeLaunchPolicy";
import { isAnalyticsUserId } from "@/lib/ga4UserIdPolicy";
import { discardResponseBody } from "./discardResponseBody";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const CONTEXT_STORAGE_KEY = "tomverse_analytics_context_v1";
const CONSENT_STORAGE_KEY = ANALYTICS_CONSENT_STORAGE_KEY;
const SIGNUP_STORAGE_KEY = "tomverse_analytics_signup_v1";
const SESSION_STORAGE_KEY = "tomverse_analytics_session_v1";
const PRECONSENT_ATTRIBUTION_STORAGE_KEY =
  "tomverse_analytics_preconsent_attribution_v1";
const PENDING_EVENTS_STORAGE_KEY = "tomverse_analytics_pending_events_v1";
const TOUCH_SEEN_STORAGE_KEY = "tomverse_analytics_touch_seen_v1";
const MAX_TOUCHES_SEEN = 20;
const MODEL_FINDER_VARIANT_STORAGE_KEY = "tomverse_model_finder_variant_v1";
const MAX_PENDING_EVENTS = 100;
const ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const GA4_DEBUG_PARAMS = ga4DebugEventParams(
  process.env.NEXT_PUBLIC_GA4_DEBUG_MODE
);

type AnalyticsRuntime = {
  attribution: AnalyticsAttribution;
  measurementId: string | null;
  plan: "Guest" | "Free" | "Pro" | "Max";
  firstSeenAt: string;
  capturedAt: string;
  sentOnce: Set<string>;
};

type IntentAttribution = {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
};

type EventIntent = {
  eventId: string;
  eventName: ProductAnalyticsEventName;
  occurredAt: string;
  modelCount: number;
  properties: ProductAnalyticsProperties;
  onceKey?: string;
  // The UTM values this event itself observed, sent in place of the
  // session's. Only a marketing touch carries one: it reports the landing URL
  // it saw, which a later landing in the same session must not overwrite.
  attribution?: IntentAttribution;
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

type StoredPreConsentAttribution = {
  firstSeenAt: string;
  capturedAt: string;
  hasUtm: boolean;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
};

let runtime: AnalyticsRuntime | null = null;
let pendingEvents: EventIntent[] = [];
const pendingOnceKeys = new Set<string>();
let ga4ConsentInitialized = false;

const applyGa4ConsentMode = (analyticsStorage: "granted" | "denied") => {
  window.dataLayer = window.dataLayer || [];
  window.gtag =
    window.gtag ||
    function gtag() {
      // gtag.js expects its command queue entries to be Arguments objects.
      // Pushing a rest-parameter array prevents the loaded tag from processing
      // the queued consent/config/event commands in some runtimes.
      // eslint-disable-next-line prefer-rest-params -- required by the gtag.js command protocol
      window.dataLayer?.push(arguments);
    };
  window.gtag(
    "consent",
    ga4ConsentInitialized ? "update" : "default",
    {
      analytics_storage: analyticsStorage,
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    }
  );
  ga4ConsentInitialized = true;
};

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

const readPreConsentAttribution = (): StoredPreConsentAttribution | null => {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(PRECONSENT_ATTRIBUTION_STORAGE_KEY) ||
        "null"
    ) as Partial<StoredPreConsentAttribution> | null;
    if (
      !parsed ||
      typeof parsed.firstSeenAt !== "string" ||
      typeof parsed.capturedAt !== "string" ||
      typeof parsed.hasUtm !== "boolean" ||
      typeof parsed.utmSource !== "string" ||
      typeof parsed.utmMedium !== "string" ||
      typeof parsed.utmCampaign !== "string"
    ) {
      return null;
    }
    return {
      firstSeenAt: parsed.firstSeenAt,
      capturedAt: parsed.capturedAt,
      hasUtm: parsed.hasUtm,
      utmSource: parsed.utmSource.slice(0, 100),
      utmMedium: parsed.utmMedium.slice(0, 100),
      utmCampaign: parsed.utmCampaign.slice(0, 100),
    };
  } catch {
    return null;
  }
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

const capturePreConsentAttribution = () => {
  const existing = readPreConsentAttribution();
  const urlUtm = currentUtm();
  const now = new Date().toISOString();
  const captured: StoredPreConsentAttribution = urlUtm
    ? {
        firstSeenAt: existing?.firstSeenAt || now,
        capturedAt: now,
        hasUtm: true,
        utmSource: urlUtm.utmSource,
        utmMedium: urlUtm.utmMedium,
        utmCampaign: urlUtm.utmCampaign,
      }
    : existing || {
        firstSeenAt: now,
        capturedAt: now,
        hasUtm: false,
        utmSource: "(direct)",
        utmMedium: "(none)",
        utmCampaign: "(not set)",
      };
  window.sessionStorage.setItem(
    PRECONSENT_ATTRIBUTION_STORAGE_KEY,
    JSON.stringify(captured)
  );
  return captured;
};

const readPendingEvents = (): EventIntent[] => {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(PENDING_EVENTS_STORAGE_KEY) || "[]"
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((candidate): EventIntent | null => {
        if (!candidate || typeof candidate !== "object") return null;
        const event = candidate as Partial<EventIntent>;
        const properties = analyticsPropertiesSchema.safeParse(event.properties);
        const attribution = event.attribution;
        const attributionValid =
          attribution === undefined ||
          (Boolean(attribution) &&
            typeof attribution === "object" &&
            typeof attribution.utmSource === "string" &&
            typeof attribution.utmMedium === "string" &&
            typeof attribution.utmCampaign === "string");
        if (
          !attributionValid ||
          !isUuid(event.eventId) ||
          typeof event.eventName !== "string" ||
          !PRODUCT_ANALYTICS_EVENT_NAMES.includes(
            event.eventName as ProductAnalyticsEventName
          ) ||
          typeof event.occurredAt !== "string" ||
          !Number.isFinite(new Date(event.occurredAt).getTime()) ||
          typeof event.modelCount !== "number" ||
          !properties.success ||
          (event.onceKey !== undefined && typeof event.onceKey !== "string")
        ) {
          return null;
        }
        return {
          eventId: event.eventId,
          eventName: event.eventName as ProductAnalyticsEventName,
          occurredAt: event.occurredAt,
          modelCount: event.modelCount,
          properties: properties.data,
          ...(event.onceKey ? { onceKey: event.onceKey.slice(0, 100) } : {}),
          ...(attribution
            ? {
                attribution: {
                  utmSource: limited(attribution.utmSource, "(direct)"),
                  utmMedium: limited(attribution.utmMedium, "(none)"),
                  utmCampaign: limited(attribution.utmCampaign, "(not set)"),
                },
              }
            : {}),
        };
      })
      .filter((event): event is EventIntent => Boolean(event))
      .slice(-MAX_PENDING_EVENTS);
  } catch {
    return [];
  }
};

const mergePendingEvents = (...eventLists: EventIntent[][]) => {
  const merged = new Map<string, EventIntent>();
  for (const event of eventLists.flat()) merged.set(event.eventId, event);
  return Array.from(merged.values())
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-MAX_PENDING_EVENTS);
};

const persistPendingEvents = (events: EventIntent[]) => {
  pendingEvents = events.slice(-MAX_PENDING_EVENTS);
  pendingOnceKeys.clear();
  for (const event of pendingEvents) {
    if (event.onceKey) pendingOnceKeys.add(event.onceKey);
  }
  window.sessionStorage.setItem(
    PENDING_EVENTS_STORAGE_KEY,
    JSON.stringify(pendingEvents)
  );
};

const queuePendingIntent = (intent: EventIntent) => {
  if (analyticsConsent() === "declined") return;
  capturePreConsentAttribution();
  persistPendingEvents(
    mergePendingEvents(readPendingEvents(), pendingEvents, [intent])
  );
};

const sessionId = () => {
  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing && /^\d{10,16}$/.test(existing)) return existing;
  const created = String(Date.now());
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
  return created;
};

const INTERNAL_DELIVERY_RETRY_DELAYS_MS = [500, 2_000] as const;
const RETRYABLE_INTERNAL_DELIVERY_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

// Bumped by disableAnalyticsClient. A retry that began in an earlier
// generation is dropped.
let deliveryGeneration = 0;

/**
 * Delivers one event, retrying a transient failure. A retry is dropped if
 * analytics was declined after the first attempt: nothing sent before a
 * withdrawal is sent again after it.
 */
const deliverInternalAnalyticsEvent = (
  payload: ReturnType<typeof analyticsClientEventSchema.parse>,
  attempt = 0,
  generation = deliveryGeneration
): Promise<void> => {
  const withdrawn = () =>
    generation !== deliveryGeneration || analyticsConsent() === "declined";
  const retry = () =>
    attempt < INTERNAL_DELIVERY_RETRY_DELAYS_MS.length && !withdrawn()
      ? new Promise<void>((resolve) =>
          window.setTimeout(resolve, INTERNAL_DELIVERY_RETRY_DELAYS_MS[attempt])
        ).then(() =>
          withdrawn()
            ? undefined
            : deliverInternalAnalyticsEvent(payload, attempt + 1, generation)
        )
      : undefined;
  return fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
    cache: "no-store",
  })
    .then(async (response) => {
      await discardResponseBody(response);
      if (
        !response.ok &&
        RETRYABLE_INTERNAL_DELIVERY_STATUSES.has(response.status)
      ) {
        return retry();
      }
    })
    .catch(() => retry())
    .then(
      () => undefined,
      () => undefined
    );
};

const sendIntent = (intent: EventIntent) => {
  if (!runtime) return;
  const storedVariant = window.localStorage.getItem(
    MODEL_FINDER_VARIANT_STORAGE_KEY
  );
  const payload = analyticsClientEventSchema.parse({
    event_id: intent.eventId,
    event_name: intent.eventName,
    occurred_at: intent.occurredAt,
    model_count: Math.max(0, Math.min(3, Math.trunc(intent.modelCount))),
    properties: {
      ...intent.properties,
      ...(storedVariant === "control" || storedVariant === "finder"
        ? { experiment_variant: storedVariant }
        : {}),
      ...localeMarketingAnalyticsProperties(runtime.attribution.language),
    },
    ...runtime.attribution,
    ...(intent.attribution
      ? {
          utm_source: intent.attribution.utmSource,
          utm_medium: intent.attribution.utmMedium,
          utm_campaign: intent.attribution.utmCampaign,
        }
      : {}),
  });

  if (shouldSendCustomProductEventToGa4(intent.eventName)) {
    window.gtag?.("event", intent.eventName, {
      utm_source: payload.utm_source,
      utm_medium: payload.utm_medium,
      utm_campaign: payload.utm_campaign,
      language: payload.language,
      country: payload.country,
      model_count: payload.model_count,
      plan: runtime.plan,
      session_id: Number(payload.session_id),
      ...GA4_DEBUG_PARAMS,
      ...payload.properties,
    });
  }

  const ecommerceEvent = ga4EcommerceEventForProductEvent(
    intent.eventName,
    payload.properties
  );
  if (ecommerceEvent) {
    window.gtag?.("event", ecommerceEvent.name, {
      utm_source: payload.utm_source,
      utm_medium: payload.utm_medium,
      utm_campaign: payload.utm_campaign,
      language: payload.language,
      country: payload.country,
      plan: runtime.plan,
      session_id: Number(payload.session_id),
      ...GA4_DEBUG_PARAMS,
      ...ecommerceEvent.params,
    });
  }

  void deliverInternalAnalyticsEvent(payload);
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
  // A (re)configuration sends a page_view and flushes queued events. Whoever's
  // User-ID was on the tag may not be who is signed in now -- the account can
  // change in the same render that re-runs this -- so it is cleared before any
  // of that goes out. The caller asks for the current account's id afterwards
  // (AnalyticsProvider, syncGa4UserId). A lookup still in flight for the
  // previous account is cancelled with it.
  clearGa4UserId();
  const now = new Date();
  const stored = readStoredContext();
  const preConsentAttribution = capturePreConsentAttribution();
  const storedCapturedAt = stored ? new Date(stored.capturedAt).getTime() : 0;
  const storedAttributionIsFresh =
    storedCapturedAt > 0 && now.getTime() - storedCapturedAt <= ATTRIBUTION_TTL_MS;
  const urlUtm = currentUtm();
  const attribution = urlUtm ||
    (preConsentAttribution.hasUtm
      ? {
          utmSource: preConsentAttribution.utmSource,
          utmMedium: preConsentAttribution.utmMedium,
          utmCampaign: preConsentAttribution.utmCampaign,
        }
      : stored && storedAttributionIsFresh
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
    firstSeenAt:
      stored?.firstSeenAt || preConsentAttribution.firstSeenAt || now.toISOString(),
    capturedAt:
      urlUtm || preConsentAttribution.hasUtm
        ? preConsentAttribution.capturedAt
        : !storedAttributionIsFresh
          ? now.toISOString()
        : stored?.capturedAt || now.toISOString(),
    sentOnce: new Set(stored?.sentOnce || []),
  };

  if (measurementId) {
    applyGa4ConsentMode("granted");
    window.gtag?.("js", now);
    window.gtag?.("config", measurementId, {
      send_page_view: true,
      client_id: runtime.attribution.client_id,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      ...GA4_DEBUG_PARAMS,
    });
  }

  const queued = mergePendingEvents(readPendingEvents(), pendingEvents);
  pendingEvents = [];
  window.sessionStorage.removeItem(PENDING_EVENTS_STORAGE_KEY);
  window.sessionStorage.removeItem(PRECONSENT_ATTRIBUTION_STORAGE_KEY);
  for (const intent of queued) {
    if (intent.onceKey && runtime.sentOnce.has(intent.onceKey)) continue;
    if (intent.onceKey) runtime.sentOnce.add(intent.onceKey);
    sendIntent(intent);
  }
  pendingOnceKeys.clear();
  writeStoredContext(runtime);
  return runtime;
};

/**
 * The GA4 User-ID currently set on the tag (docs/policy/marketing-automation.md
 * §10.2). Whether one may be set at all is lib/ga4UserIdPolicy.ts's decision,
 * made by the caller; this only applies it. `null` clears it, which is what
 * signing out and declining analytics do -- GA4 asks for a real `null`, not an
 * empty string.
 *
 * Nothing is pushed while there is no tag, and nothing is pushed for a value
 * that is already set, so a visitor for whom the feature is off never has a
 * `user_id` command queued at all.
 */
let ga4UserId: string | null = null;

export const applyGa4UserId = (value: string | null) => {
  const next = isAnalyticsUserId(value) ? value : null;
  if (next === ga4UserId) return;
  if (next !== null && (!runtime?.measurementId || !window.gtag)) return;
  ga4UserId = next;
  window.gtag?.("set", { user_id: next });
};

/** A withdrawal this browser has sent and not yet seen answered. */
let ga4UserIdWithdrawal: Promise<void> | null = null;

// The caller asks only once the visitor explicitly accepted analytics
// (lib/ga4UserIdPolicy.ts), and says so: the server creates no id for a
// request that does not. A withdrawal sent from this browser is answered
// first, so declining and then accepting again cannot be handed the id that
// is being withdrawn.
const requestAnalyticsUserId = async (signal: AbortSignal) => {
  await ga4UserIdWithdrawal;
  if (signal.aborted) return null;
  const response = await fetch("/api/analytics/user-id", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consent: "accepted" }),
    signal,
  });
  if (!response.ok) {
    await discardResponseBody(response);
    return null;
  }
  const body = (await response.json()) as { analyticsUserId?: unknown };
  return typeof body.analyticsUserId === "string" ? body.analyticsUserId : null;
};

/**
 * Brings the tag's User-ID in line with who is signed in now. Whatever was set
 * is cleared first, before anything is asked: when the session moves from one
 * account to another, the first account's id must not label a single event of
 * the second's -- not while the lookup runs, and not after it fails. Only a
 * lookup that finishes un-cancelled sets a new one. Returns the cancel.
 */
let ga4UserIdLookup: AbortController | null = null;

/** Clears the tag's User-ID and cancels any lookup still in flight. */
const clearGa4UserId = () => {
  ga4UserIdLookup?.abort();
  ga4UserIdLookup = null;
  applyGa4UserId(null);
};

export const syncGa4UserId = (
  allowed: boolean,
  requestId: (signal: AbortSignal) => Promise<string | null> = requestAnalyticsUserId
) => {
  clearGa4UserId();
  if (!allowed) return () => {};
  const controller = new AbortController();
  ga4UserIdLookup = controller;
  requestId(controller.signal)
    .then((analyticsUserId) => {
      if (!controller.signal.aborted) applyGa4UserId(analyticsUserId);
    })
    .catch(() => {});
  return () => controller.abort();
};

/**
 * Withdrawal of the account's GA4 User-ID, for a visitor who declined
 * analytics while signed in (docs/policy/marketing-automation.md §10.2): the
 * tag's id is cleared here and the server asks GA4 to delete what it holds
 * under the stored id, then deletes it. One request, kept alive past a
 * navigation and never retried; whether it may be made at all is the caller's
 * decision (`ga4UserIdWithdrawalApplies`).
 */
export const withdrawGa4UserId = () => {
  clearGa4UserId();
  const withdrawal: Promise<void> = fetch("/api/analytics/user-id", {
    method: "DELETE",
    cache: "no-store",
    keepalive: true,
  })
    .then(discardResponseBody)
    .catch(() => {})
    .finally(() => {
      if (ga4UserIdWithdrawal === withdrawal) ga4UserIdWithdrawal = null;
    });
  ga4UserIdWithdrawal = withdrawal;
  return withdrawal;
};

export const disableAnalyticsClient = () => {
  clearGa4UserId();
  applyGa4ConsentMode("denied");
  runtime = null;
  pendingEvents = [];
  pendingOnceKeys.clear();
  deliveryGeneration += 1;
  window.localStorage.removeItem(CONTEXT_STORAGE_KEY);
  window.localStorage.removeItem(SIGNUP_STORAGE_KEY);
  window.sessionStorage.removeItem(SIGNUP_STORAGE_KEY);
  window.sessionStorage.removeItem(PENDING_EVENTS_STORAGE_KEY);
  window.sessionStorage.removeItem(PRECONSENT_ATTRIBUTION_STORAGE_KEY);
  window.sessionStorage.removeItem(TOUCH_SEEN_STORAGE_KEY);
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name === "_ga" || name?.startsWith("_ga_")) {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
      const hostname = window.location.hostname;
      if (hostname.includes(".")) {
        document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${hostname}; SameSite=Lax`;
      }
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
    queuePendingIntent(intent);
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
  const alreadyPending = mergePendingEvents(
    readPendingEvents(),
    pendingEvents
  ).some((event) => event.onceKey === onceKey);
  if (
    runtime?.sentOnce.has(onceKey) ||
    pendingOnceKeys.has(onceKey) ||
    alreadyPending
  ) {
    return;
  }
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
    queuePendingIntent(intent);
    return;
  }
  runtime.sentOnce.add(onceKey);
  writeStoredContext(runtime);
  sendIntent(intent);
}

/**
 * Report the UTM parameters in the current URL as a `marketing_touch`
 * (docs/policy/marketing-automation.md §10.1).
 *
 * Under the same consent rule as every other event: nothing when analytics was
 * declined, held in this tab's pending queue until the visitor's choice allows
 * analytics, and dropped with that queue if it never does. The server times
 * the touch by its receipt, so a touch that waited for consent is recorded
 * when consent was given, not when the page loaded -- which is what
 * "client-observed, server-timed" says.
 *
 * Once per distinct set of values per tab session: a reload of the same
 * landing URL is not a second touch, a different link is.
 */
export const observeMarketingTouch = () => {
  if (typeof window === "undefined") return;
  if (analyticsConsent() === "declined") return;
  const params = new URLSearchParams(window.location.search);
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
  if (!keys.some((key) => params.has(key))) return;
  const attribution: IntentAttribution = {
    utmSource: limited(params.get("utm_source"), "(direct)"),
    utmMedium: limited(params.get("utm_medium"), "(none)"),
    utmCampaign: limited(params.get("utm_campaign"), "(not set)"),
  };
  const utmContent = params.get("utm_content")?.trim().slice(0, 100) || null;
  const seenKey = JSON.stringify([
    attribution.utmSource,
    attribution.utmMedium,
    attribution.utmCampaign,
    utmContent,
  ]);
  let seen: string[] = [];
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(TOUCH_SEEN_STORAGE_KEY) || "[]"
    ) as unknown;
    if (Array.isArray(parsed)) {
      seen = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    seen = [];
  }
  if (seen.includes(seenKey)) return;
  const properties = analyticsPropertiesSchema.safeParse(
    utmContent ? { utm_content: utmContent } : {}
  );
  if (!properties.success) return;
  const intent: EventIntent = {
    eventId: crypto.randomUUID(),
    eventName: "marketing_touch",
    occurredAt: new Date().toISOString(),
    modelCount: 0,
    properties: properties.data,
    attribution,
  };
  if (runtime) sendIntent(intent);
  else queuePendingIntent(intent);
  // Marked seen only once it has been sent or queued.
  window.sessionStorage.setItem(
    TOUCH_SEEN_STORAGE_KEY,
    JSON.stringify([...seen, seenKey].slice(-MAX_TOUCHES_SEEN))
  );
};

export const markSignupStarted = (method: string) => {
  if (analyticsConsent() === "declined") return;
  const normalizedMethod = method.trim().slice(0, 32) || "unknown";
  window.sessionStorage.setItem(
    SIGNUP_STORAGE_KEY,
    JSON.stringify({ method: normalizedMethod, startedAt: new Date().toISOString() })
  );
  trackProductEvent("signup_started", 0, { method: normalizedMethod });
};

export const consumeSignupStarted = () => {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(SIGNUP_STORAGE_KEY) ||
        window.localStorage.getItem(SIGNUP_STORAGE_KEY) ||
        "null"
    ) as { method?: unknown; startedAt?: unknown } | null;
    window.localStorage.removeItem(SIGNUP_STORAGE_KEY);
    window.sessionStorage.removeItem(SIGNUP_STORAGE_KEY);
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
    window.sessionStorage.removeItem(SIGNUP_STORAGE_KEY);
    return null;
  }
};

export const getAnalyticsAttributionSnapshot = () => runtime?.attribution || null;
