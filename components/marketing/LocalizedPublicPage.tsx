import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { LanguageProvider } from "@/components/LanguageProvider";
import { MARKETING_LOCALE_ALIASES, marketingLocaleFor } from "@/lib/marketingLocale";
import type { LocalizedPublicPageProps, PublicMarketingPagePath } from "@/lib/publicMarketingMetadata";
import { localizedPath } from "@/lib/seo";

/** Locale is fixed for the first HTML and stays fixed through hydration. */
export async function LocalizedPublicPage({ params, path, children }: LocalizedPublicPageProps & {
  path: PublicMarketingPagePath;
  children: ReactNode;
}) {
  const { locale } = await params;
  const lang = marketingLocaleFor(locale);
  if (!lang) notFound();
  if (MARKETING_LOCALE_ALIASES[locale.toLowerCase()]) redirect(localizedPath(lang, path));
  return <div lang={lang}><LanguageProvider initialLang={lang} forceInitialLang>{children}</LanguageProvider></div>;
}
