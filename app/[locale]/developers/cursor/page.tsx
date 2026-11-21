import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LanguageProvider } from "@/components/LanguageProvider";
import { MARKETING_LOCALE_ALIASES, marketingLocaleFor } from "@/lib/marketingLocale";
import { CursorGuidePage } from "@/components/marketing/v2/cursor/CursorGuidePage";
import { cursorGuideSeo } from "@/components/marketing/v2/cursor/cursorGuideContent";
import { CURSOR_GUIDE_PATH } from "@/lib/marketingRoutes";
import { SEO_LOCALES, createPageMetadata, localizedPath } from "@/lib/seo";

type LocalizedPageProps = { params: Promise<{ locale: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return [...SEO_LOCALES, ...Object.keys(MARKETING_LOCALE_ALIASES)].map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocalizedPageProps): Promise<Metadata> {
  const { locale } = await params;
  const lang = marketingLocaleFor(locale);
  if (!lang) return {};
  return createPageMetadata({
    title: cursorGuideSeo[lang].title,
    description: cursorGuideSeo[lang].description,
    path: localizedPath(lang, CURSOR_GUIDE_PATH),
    locale: lang,
    localizedBasePath: CURSOR_GUIDE_PATH,
  });
}

export default async function LocalizedPage({ params }: LocalizedPageProps) {
  const { locale } = await params;
  const lang = marketingLocaleFor(locale);
  if (!lang) notFound();
  if (MARKETING_LOCALE_ALIASES[locale.toLowerCase()] || locale !== lang) redirect(localizedPath(lang, CURSOR_GUIDE_PATH));
  return (
    <div lang={lang}>
      <LanguageProvider initialLang={lang} forceInitialLang>
        <CursorGuidePage />
      </LanguageProvider>
    </div>
  );
}
