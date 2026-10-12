"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import SessionProviderWrapper from "@/components/auth/SessionProviderWrapper";
import {
  LanguageProvider,
  useLanguage,
  type Language,
} from "@/components/LanguageProvider";
import { isAppLanguage } from "@/lib/localizedCallbackUrl";
import { ModelCatalogProvider } from "@/components/ModelCatalogProvider";

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

function MarketingLanguageQuerySync({ enabled }: { enabled: boolean }) {
  const searchParams = useSearchParams();
  const { lang, setLang } = useLanguage();
  const requestedLanguage = searchParams.get("lang");

  useEffect(() => {
    if (
      enabled &&
      isAppLanguage(requestedLanguage) &&
      requestedLanguage !== lang
    ) {
      setLang(requestedLanguage);
    }
  }, [enabled, lang, requestedLanguage, setLang]);

  return null;
}

function SessionAwareMarketingProviders({
  children,
  measurementId,
  initialLang: suppliedInitialLang,
  forceInitialLang = false,
  nonce,
}: {
  children: React.ReactNode;
  measurementId: string | null;
  initialLang?: Language;
  forceInitialLang?: boolean;
  nonce?: string | null;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const pathLanguage = pathnameLanguage(pathname);
  const initialLang = pathLanguage || suppliedInitialLang || "en";

  return (
    <LanguageProvider
      initialLang={initialLang}
      forceInitialLang={pathLanguage !== null || forceInitialLang}
    >
      <Suspense fallback={null}>
        <MarketingLanguageQuerySync enabled={pathLanguage === null} />
      </Suspense>
      <AnalyticsProvider
        country="ZZ"
        initialPlan={normalizePlan(
          session?.user?.plan,
          Boolean(session?.user?.id)
        )}
        measurementId={measurementId}
        nonce={nonce || null}
        userCreatedAt={session?.user?.createdAt || null}
      >
        <ModelCatalogProvider>{children}</ModelCatalogProvider>
      </AnalyticsProvider>
    </LanguageProvider>
  );
}

export function MarketingProviders({
  children,
  measurementId,
  initialLang,
  forceInitialLang,
  nonce,
}: {
  children: React.ReactNode;
  measurementId: string | null;
  initialLang?: Language;
  forceInitialLang?: boolean;
  nonce?: string | null;
}) {
  return (
    <SessionProviderWrapper>
      <SessionAwareMarketingProviders measurementId={measurementId} initialLang={initialLang} forceInitialLang={forceInitialLang} nonce={nonce}>
        {children}
      </SessionAwareMarketingProviders>
    </SessionProviderWrapper>
  );
}
