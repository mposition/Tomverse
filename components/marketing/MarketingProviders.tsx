"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import SessionProviderWrapper from "@/components/auth/SessionProviderWrapper";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";

const localeAliases: Record<string, Language> = { kr: "ko", cn: "zh" };
const supportedLocales = new Set<Language>([
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
]);

const pathnameLanguage = (pathname: string): Language | null => {
  const candidate = pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!candidate) return null;
  if (candidate in localeAliases) return localeAliases[candidate];
  return supportedLocales.has(candidate as Language)
    ? (candidate as Language)
    : null;
};

const normalizePlan = (
  value: unknown,
  authenticated: boolean
): "Guest" | "Free" | "Pro" | "Max" => {
  if (value === "Pro" || value === "Max") return value;
  return authenticated ? "Free" : "Guest";
};

function SessionAwareMarketingProviders({
  children,
  measurementId,
}: {
  children: React.ReactNode;
  measurementId: string | null;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const initialLang = pathnameLanguage(pathname) || "en";

  return (
    <LanguageProvider
      initialLang={initialLang}
      forceInitialLang={pathnameLanguage(pathname) !== null}
    >
      <AnalyticsProvider
        country="ZZ"
        initialPlan={normalizePlan(
          session?.user?.plan,
          Boolean(session?.user?.id)
        )}
        measurementId={measurementId}
        nonce={null}
        userCreatedAt={session?.user?.createdAt || null}
      >
        {children}
      </AnalyticsProvider>
    </LanguageProvider>
  );
}

export function MarketingProviders({
  children,
  measurementId,
}: {
  children: React.ReactNode;
  measurementId: string | null;
}) {
  return (
    <SessionProviderWrapper>
      <SessionAwareMarketingProviders measurementId={measurementId}>
        {children}
      </SessionAwareMarketingProviders>
    </SessionProviderWrapper>
  );
}
