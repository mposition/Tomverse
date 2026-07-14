export const dynamic = "force-dynamic";

import { cookies, headers } from "next/headers";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import SessionProviderWrapper from "@/components/auth/SessionProviderWrapper";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";
import { authOptions } from "@/lib/auth";

const detectInitialLanguage = (acceptLanguage: string | null): Language => {
  const candidates =
    acceptLanguage
      ?.toLowerCase()
      .split(",")
      .map((part) => part.split(";")[0]?.trim())
      .filter(Boolean) ?? [];

  for (const candidate of candidates) {
    if (candidate === "ko" || candidate.startsWith("ko-")) return "ko";
    if (candidate === "zh" || candidate.startsWith("zh-")) return "zh";
    if (candidate === "fr" || candidate.startsWith("fr-")) return "fr";
    if (candidate === "de" || candidate.startsWith("de-")) return "de";
    if (candidate === "es" || candidate.startsWith("es-")) return "es";
    if (candidate === "pt" || candidate.startsWith("pt-")) return "pt";
    if (candidate === "en" || candidate.startsWith("en-")) return "en";
  }

  return "en";
};

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
  const initialLang = detectInitialLanguage(requestHeaders.get("accept-language"));
  const nonce = requestHeaders.get("x-nonce");
  const countryCandidate = requestHeaders.get("cf-ipcountry")?.trim().toUpperCase();
  const analyticsCountry =
    countryCandidate && /^[A-Z]{2}$/.test(countryCandidate)
      ? countryCandidate
      : "ZZ";

  try {
    const e2eCookies =
      process.env.E2E_AUTH_BYPASS === "true" ? await cookies() : null;
    const e2eAuthCookie = e2eCookies?.get("__tomverse_e2e_auth")?.value;
    e2eAnalyticsEnabled =
      e2eCookies?.get("__tomverse_e2e_analytics")?.value === "1";

    if (process.env.E2E_AUTH_BYPASS === "true" && e2eAuthCookie === "1") {
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
      <LanguageProvider initialLang={initialLang}>
        <AnalyticsProvider
          country={analyticsCountry}
          initialPlan={normalizePlan(session?.user?.plan, Boolean(session?.user?.id))}
          measurementId={measurementId}
          nonce={nonce}
          userCreatedAt={session?.user?.createdAt || null}
          disabled={
            process.env.E2E_AUTH_BYPASS === "true" && !e2eAnalyticsEnabled
          }
        >
          {children}
        </AnalyticsProvider>
      </LanguageProvider>
    </SessionProviderWrapper>
  );
}
