import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import LaunchHomepage from "@/components/marketing/LaunchHomepage";
import { homepageProductLinks } from "@/lib/homepageProductLinks";
import { MarketingChatAvailabilityProvider } from "@/components/marketing/MarketingChatAvailability";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";
import {
  SEO_LOCALES,
  createPageMetadata,
  getHomeOgCopy,
  getHomeSeoCopy,
  localizedPath,
} from "@/lib/seo";

const localeAliases: Record<string, Language> = {
  kr: "ko",
  cn: "zh",
};

const supportedLocales = new Set<Language>([
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
]);

const normalizeLocale = (value: string): Language | null => {
  const lowered = value.toLowerCase();
  if (lowered in localeAliases) return localeAliases[lowered];
  return supportedLocales.has(lowered as Language) ? (lowered as Language) : null;
};

type LocalePageProps = {
  params: Promise<{ locale: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return [...SEO_LOCALES, ...Object.keys(localeAliases)].map((locale) => ({
    locale,
  }));
}

export async function generateMetadata({
  params,
}: LocalePageProps): Promise<Metadata> {
  const { locale } = await params;
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale) return {};

  const copy = getHomeSeoCopy(normalizedLocale, PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);
  const ogCopy = getHomeOgCopy(normalizedLocale, PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);
  return createPageMetadata({
    title: copy.title,
    description: copy.description,
    path: localizedPath(normalizedLocale, "/"),
    locale: normalizedLocale,
    localizedBasePath: "/",
    ogTitle: ogCopy.title,
    ogDescription: ogCopy.description,
  });
}

export default async function LocalizedLandingPage({ params }: LocalePageProps) {
  const { locale } = await params;
  const loweredLocale = locale.toLowerCase();
  const normalizedLocale = normalizeLocale(locale);

  if (!normalizedLocale) {
    notFound();
  }

  if (localeAliases[loweredLocale]) {
    redirect(`/${normalizedLocale}`);
  }

  return (
    <div lang={normalizedLocale}>
      <LanguageProvider initialLang={normalizedLocale} forceInitialLang>
        <MarketingChatAvailabilityProvider guestTrialAvailable={PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE}>
          <LaunchHomepage {...homepageProductLinks(normalizedLocale)} />
        </MarketingChatAvailabilityProvider>
      </LanguageProvider>
    </div>
  );
}
