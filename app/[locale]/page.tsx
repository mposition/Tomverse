import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";
import {
  createPageMetadata,
  homeSeoCopy,
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

export async function generateMetadata({
  params,
}: LocalePageProps): Promise<Metadata> {
  const { locale } = await params;
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale) return {};

  const copy = homeSeoCopy[normalizedLocale];
  return createPageMetadata({
    title: copy.title,
    description: copy.description,
    path: localizedPath(normalizedLocale, "/"),
    locale: normalizedLocale,
    localizedBasePath: "/",
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
    <LanguageProvider initialLang={normalizedLocale} forceInitialLang>
      <LandingPageContent />
    </LanguageProvider>
  );
}
