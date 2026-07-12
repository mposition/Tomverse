import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";

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

  return {
    alternates: {
      canonical: `/${normalizedLocale}`,
      languages: {
        en: "/en",
        ko: "/ko",
        "zh-CN": "/zh",
        fr: "/fr",
        de: "/de",
        es: "/es",
        pt: "/pt",
        "x-default": "/",
      },
    },
  };
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
