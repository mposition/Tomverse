import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LanguageProvider } from "@/components/LanguageProvider";
import { MARKETING_LOCALE_ALIASES, marketingLocaleFor } from "@/lib/marketingLocale";
import { ChatProductPage } from "@/components/marketing/v2/chat/ChatProductPage";
import { chatPageSeo } from "@/components/marketing/v2/chat/chatPageContent";
import { CHAT_PRODUCT_PATH } from "@/lib/marketingRoutes";
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
    title: chatPageSeo[lang].title,
    description: chatPageSeo[lang].description,
    path: localizedPath(lang, CHAT_PRODUCT_PATH),
    locale: lang,
    localizedBasePath: CHAT_PRODUCT_PATH,
  });
}

export default async function LocalizedPage({ params }: LocalizedPageProps) {
  const { locale } = await params;
  const lang = marketingLocaleFor(locale);
  if (!lang) notFound();
  if (MARKETING_LOCALE_ALIASES[locale.toLowerCase()] || locale !== lang) redirect(localizedPath(lang, CHAT_PRODUCT_PATH));
  return (
    <div lang={lang}>
      <LanguageProvider initialLang={lang} forceInitialLang>
        <ChatProductPage />
      </LanguageProvider>
    </div>
  );
}
