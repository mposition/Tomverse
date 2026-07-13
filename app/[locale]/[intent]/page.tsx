import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import {
  SEARCH_INTENT_SLUGS,
  isSearchIntentSlug,
  searchIntentPages,
} from "@/components/marketing/searchIntentContent";
import {
  SEO_LOCALES,
  createPageMetadata,
  isSeoLocale,
  localizedPath,
} from "@/lib/seo";

const localeAliases: Record<string, Language> = { kr: "ko", cn: "zh" };

type LocalizedIntentPageProps = {
  params: Promise<{ locale: string; intent: string }>;
};

export function generateStaticParams() {
  return SEO_LOCALES.flatMap((locale) =>
    SEARCH_INTENT_SLUGS.map((intent) => ({ locale, intent }))
  );
}

export async function generateMetadata({
  params,
}: LocalizedIntentPageProps): Promise<Metadata> {
  const { locale, intent } = await params;
  const normalizedLocale = localeAliases[locale.toLowerCase()] || locale.toLowerCase();
  if (!isSeoLocale(normalizedLocale) || !isSearchIntentSlug(intent)) return {};
  const copy = searchIntentPages[intent][normalizedLocale];
  const basePath = `/${intent}`;
  return createPageMetadata({
    title: copy.metadataTitle,
    description: copy.metadataDescription,
    path: localizedPath(normalizedLocale, basePath),
    locale: normalizedLocale,
    localizedBasePath: basePath,
  });
}

export default async function LocalizedIntentPage({
  params,
}: LocalizedIntentPageProps) {
  const { locale, intent } = await params;
  const loweredLocale = locale.toLowerCase();
  const normalizedLocale = localeAliases[loweredLocale] || loweredLocale;
  if (!isSeoLocale(normalizedLocale) || !isSearchIntentSlug(intent)) notFound();
  if (localeAliases[loweredLocale]) {
    redirect(localizedPath(normalizedLocale, `/${intent}`));
  }

  return (
    <LanguageProvider initialLang={normalizedLocale} forceInitialLang>
      <MarketingInfoPage content={searchIntentPages[intent]} />
    </LanguageProvider>
  );
}
