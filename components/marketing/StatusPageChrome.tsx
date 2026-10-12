"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LanguageProvider, useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingHeader, MarketingFooter } from "./MarketingChrome";
import { MarketingChatAvailabilityProvider } from "./MarketingChatAvailability";

function StatusLanguageNavigation({ servedLanguage }: { servedLanguage: Language }) {
  const { lang } = useLanguage();
  const router = useRouter();
  useEffect(() => {
    if (lang === servedLanguage) return;
    // Restore the visitor's existing choice, then request the matching server
    // body. Inferred status-page language must never replace that preference.
    const url = new URL(window.location.href);
    url.searchParams.set("lang", lang);
    router.replace(`${url.pathname}${url.search}${url.hash}`);
  }, [lang, servedLanguage, router]);
  return null;
}

export function StatusPageChrome({ language, guestTrialAvailable, children }: {
  language: Language; guestTrialAvailable: boolean; children: ReactNode;
}) {
  return <LanguageProvider key={language} initialLang={language}>
    <StatusLanguageNavigation servedLanguage={language} />
    <MarketingChatAvailabilityProvider guestTrialAvailable={guestTrialAvailable}>
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </MarketingChatAvailabilityProvider>
  </LanguageProvider>;
}
