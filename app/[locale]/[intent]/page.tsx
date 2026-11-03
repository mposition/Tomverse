import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LanguageProvider } from "@/components/LanguageProvider";
import { MARKETING_LOCALE_ALIASES, marketingLocaleFor } from "@/lib/marketingLocale";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import {
  SEARCH_INTENT_SLUGS,
  isSearchIntentSlug,
  searchIntentPages,
} from "@/components/marketing/searchIntentContent";
import {
  SEO_LOCALES,
  createPageMetadata,
  localizedPath,
} from "@/lib/seo";

const localeAliases = MARKETING_LOCALE_ALIASES;

type LocalizedIntentPageProps = {
  params: Promise<{ locale: string; intent: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return [...SEO_LOCALES, ...Object.keys(localeAliases)].flatMap((locale) =>
    SEARCH_INTENT_SLUGS.map((intent) => ({ locale, intent }))
  );
}

export async function generateMetadata({
  params,
}: LocalizedIntentPageProps): Promise<Metadata> {
  const { locale, intent } = await params;
  const normalizedLocale = marketingLocaleFor(locale);
  if (!normalizedLocale || !isSearchIntentSlug(intent)) return {};
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
  const normalizedLocale = marketingLocaleFor(locale);
  if (!normalizedLocale || !isSearchIntentSlug(intent)) notFound();
  if (localeAliases[loweredLocale] || locale !== normalizedLocale) {
    redirect(localizedPath(normalizedLocale, `/${intent}`));
  }

  return (
    <div lang={normalizedLocale}>
      <LanguageProvider initialLang={normalizedLocale} forceInitialLang>
        <MarketingInfoPage
          content={searchIntentPages[intent]}
          template={
            intent === "chatgpt-vs-claude"
              ? "chatgpt-vs-claude"
              : intent === "ai-answer-review"
                ? "ai-answer-review"
                : undefined
          }
        />
      </LanguageProvider>
    </div>
  );
}
