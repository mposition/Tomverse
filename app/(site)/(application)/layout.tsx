export const dynamic = "force-dynamic";

import { cookies, headers } from "next/headers";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import SessionProviderWrapper from "@/components/auth/SessionProviderWrapper";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";
import {
  DOCUMENT_LANGUAGE_HEADER,
  DOCUMENT_LANGUAGE_SOURCE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";
import {
  normalizeAnalyticsCountry,
  resolveAnalyticsConsentPolicy,
} from "@/lib/analyticsConsentPolicy";
import { authOptions } from "@/lib/auth";
import { isE2EAuthBypassEnabled } from "@/lib/e2eTestMode";
import { ModelCatalogProvider } from "@/components/ModelCatalogProvider";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { AVAILABLE_MODELS } from "@/lib/models";

const normalizePlan = (
  value: unknown,
  authenticated: boolean
): "Guest" | "Free" | "Pro" | "Max" => {
  if (value === "Pro" || value === "Max") return value;
  return authenticated ? "Free" : "Guest";
};

export default async function ApplicationLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let session: Session | null = null;
  let e2eAnalyticsEnabled = false;
  const requestHeaders = await headers();
  // VAL-004. The same resolution the root layout puts in `<html lang>`, so the
  // language this layout *renders* and the language the document *declares*
  // can never disagree. It used to read `Accept-Language` alone, which meant
  // `/chat?lang=ko` from an English-preferring browser server-rendered English
  // copy -- and would now have shipped it under `lang="ko"`.
  const resolvedLang = requestHeaders.get(DOCUMENT_LANGUAGE_HEADER);
  const initialLang: Language = isSupportedDocumentLanguage(resolvedLang)
    ? resolvedLang
    : "en";
  // An explicit `?lang=` is pinned so the client cannot restore a different
  // saved language over the one the server just rendered (VAL-003). Anything
  // inferred stays overridable, exactly as before.
  const forceInitialLang =
    requestHeaders.get(DOCUMENT_LANGUAGE_SOURCE_HEADER) === "search";
  const nonce = requestHeaders.get("x-nonce");
  const analyticsCountry = normalizeAnalyticsCountry(
    requestHeaders.get("cf-ipcountry") ||
      requestHeaders.get("x-vercel-ip-country")
  );
  const analyticsConsentPolicy = resolveAnalyticsConsentPolicy(
    analyticsCountry,
    process.env.ANALYTICS_DEFAULT_ENABLED_COUNTRIES
  );
  const initialModels = await getRuntimeModels({ includeCatalogDeleted: true }).catch((error) => {
    console.error("Application model registry fetch error:", error);
    return [...AVAILABLE_MODELS];
  });

  try {
    const e2eCookies =
      isE2EAuthBypassEnabled() ? await cookies() : null;
    const e2eAuthCookie = e2eCookies?.get("__tomverse_e2e_auth")?.value;
    e2eAnalyticsEnabled =
      e2eCookies?.get("__tomverse_e2e_analytics")?.value === "1";

    if (isE2EAuthBypassEnabled() && e2eAuthCookie === "1") {
      session = {
        user: {
          id: "qa-user",
          name: "QA User",
          email: "qa@tomverse.app",
          image: null,
          plan: "Free",
        },
        expires: "2099-01-01T00:00:00.000Z",
      } as Session;
    } else {
      session = await getServerSession(authOptions);
    }
  } catch (error) {
    console.error("Application layout session fetch error:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const configuredMeasurementId = process.env.GA4_MEASUREMENT_ID?.trim();
  const measurementId =
    configuredMeasurementId && /^G-[A-Z0-9]+$/.test(configuredMeasurementId)
      ? configuredMeasurementId
      : null;

  return (
    <SessionProviderWrapper session={session}>
      <LanguageProvider
        initialLang={initialLang}
        forceInitialLang={forceInitialLang}
      >
        <AnalyticsProvider
          country={analyticsCountry}
          initialPlan={normalizePlan(session?.user?.plan, Boolean(session?.user?.id))}
          measurementId={measurementId}
          nonce={nonce}
          userCreatedAt={session?.user?.createdAt || null}
          initialConsentMode={analyticsConsentPolicy.mode}
          disabled={
            isE2EAuthBypassEnabled() && !e2eAnalyticsEnabled
          }
        >
          <ModelCatalogProvider initialModels={initialModels}>
            {children}
          </ModelCatalogProvider>
        </AnalyticsProvider>
      </LanguageProvider>
    </SessionProviderWrapper>
  );
}
