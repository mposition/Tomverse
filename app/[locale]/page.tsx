import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import LaunchHomepage from "@/components/marketing/LaunchHomepage";
import { LandingExperimentBeacon } from "@/components/marketing/LandingExperimentBeacon";
import { homepageProductLinks } from "@/lib/homepageProductLinks";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import { LanguageProvider } from "@/components/LanguageProvider";
import { MARKETING_LOCALE_ALIASES, marketingLocaleFor } from "@/lib/marketingLocale";
import {
  SEO_LOCALES,
  createPageMetadata,
  getHomeOgCopy,
  getHomeSeoCopy,
  localizedPath,
} from "@/lib/seo";

const localeAliases = MARKETING_LOCALE_ALIASES;
const normalizeLocale = marketingLocaleFor;

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
    absoluteTitle: true,
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

  if (localeAliases[loweredLocale] || locale !== normalizedLocale) {
    redirect(`/${normalizedLocale}`);
  }

  return (
    <div lang={normalizedLocale}>
      <LanguageProvider initialLang={normalizedLocale} forceInitialLang>
        <LaunchHomepage {...homepageProductLinks(normalizedLocale)} />
        <LandingExperimentBeacon renderedArm="control" locale={normalizedLocale} />
      </LanguageProvider>
    </div>
  );
}
