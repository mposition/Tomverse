import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LanguageProvider, type Language } from "@/components/LanguageProvider";
import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { REVIEW_PRODUCT_PATH } from "@/lib/marketingRoutes";
import { SEO_LOCALES, createPageMetadata, isSeoLocale, localizedPath, reviewOgCopy, reviewSeoCopy } from "@/lib/seo";

const localeAliases: Record<string, Language> = { kr: "ko", cn: "zh" };
type LocalizedReviewProductProps = { params: Promise<{ locale: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return [...SEO_LOCALES, ...Object.keys(localeAliases)].map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocalizedReviewProductProps): Promise<Metadata> {
  const { locale } = await params;
  const normalizedLocale = localeAliases[locale.toLowerCase()] || locale.toLowerCase();
  if (!isSeoLocale(normalizedLocale)) return {};
  return createPageMetadata({
    title: reviewSeoCopy[normalizedLocale].title,
    description: reviewSeoCopy[normalizedLocale].description,
    path: localizedPath(normalizedLocale, REVIEW_PRODUCT_PATH),
    locale: normalizedLocale,
    localizedBasePath: REVIEW_PRODUCT_PATH,
    ogTitle: reviewOgCopy[normalizedLocale].title,
    ogDescription: reviewOgCopy[normalizedLocale].description,
  });
}

export default async function LocalizedReviewProductPage({ params }: LocalizedReviewProductProps) {
  const { locale } = await params;
  const loweredLocale = locale.toLowerCase();
  const normalizedLocale = localeAliases[loweredLocale] || loweredLocale;
  if (!isSeoLocale(normalizedLocale)) notFound();
  if (localeAliases[loweredLocale]) redirect(localizedPath(normalizedLocale, REVIEW_PRODUCT_PATH));
  return (
    <div lang={normalizedLocale}>
      <LanguageProvider initialLang={normalizedLocale} forceInitialLang>
        <LandingPageContent />
      </LanguageProvider>
    </div>
  );
}
