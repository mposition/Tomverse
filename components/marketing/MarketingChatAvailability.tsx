"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { startLandingChatCapabilityRead } from "@/lib/landingChatCapabilityClient";
import { marketingProductEntryHref } from "@/lib/marketingRoutes";
import { localizedPath } from "@/lib/seo";

type MarketingChatAvailability = {
  chatAvailable: boolean;
  guestTrialAvailable: boolean;
  isAuthenticated: boolean;
};

const AvailabilityContext = createContext<MarketingChatAvailability>({
  chatAvailable: false,
  guestTrialAvailable: false,
  isAuthenticated: false,
});

/** A static public offer is separate from the account's private capability. */
export function MarketingChatAvailabilityProvider({ guestTrialAvailable, children }: {
  guestTrialAvailable: boolean;
  children: ReactNode;
}) {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const accountUserId = isAuthenticated && typeof session?.user?.id === "string" && session.user.id.length > 0
    ? session.user.id : null;
  // Every identity transition gets a fresh token, even A-to-B-to-A. Old
  // results fail closed in the transition render, before effect cleanup.
  // Only eligibility is reset; the page's gallery and hero stay mounted.
  const identityToken = useMemo(() => ({ accountUserId, isAuthenticated }), [accountUserId, isAuthenticated]);
  const [result, setResult] = useState<{ token: object; offered: boolean } | null>(null);
  useEffect(() => startLandingChatCapabilityRead({
    accountUserId,
    onResolved: offered => setResult({ token: identityToken, offered }),
  }), [accountUserId, identityToken]);
  const accountOffered = result?.token === identityToken && result.offered;
  return (
    <AvailabilityContext.Provider value={{
      chatAvailable: isAuthenticated ? Boolean(accountUserId) && accountOffered : status === "unauthenticated" && guestTrialAvailable,
      guestTrialAvailable,
      isAuthenticated,
    }}>
      {children}
    </AvailabilityContext.Provider>
  );
}

export function useMarketingChatEntry() {
  const availability = useContext(AvailabilityContext);
  const { lang } = useLanguage();
  const chatInfoHref = `${localizedPath(lang, "/")}#chat`;
  const chatHref = availability.chatAvailable
    ? marketingProductEntryHref("chat", lang, availability.isAuthenticated)
    : chatInfoHref;
  const reviewHref = marketingProductEntryHref("review", lang, availability.isAuthenticated);
  return {
    ...availability,
    chatInfoHref,
    chatHref,
    reviewHref,
    primaryHref: availability.chatAvailable ? chatHref : reviewHref,
    primaryProduct: availability.chatAvailable ? "chat" as const : "review" as const,
  };
}
