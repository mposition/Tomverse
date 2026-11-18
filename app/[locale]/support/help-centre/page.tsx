import type { Metadata } from "next";
import { HelpCentreHub } from "@/components/help/HelpCentreHub";
import { LocalizedPublicPage } from "@/components/marketing/LocalizedPublicPage";
import { helpCentreCopy } from "@/lib/helpCentre/copy";
import { helpHubMetadata } from "@/lib/helpCentre/metadata";
import { marketingLocaleFor } from "@/lib/marketingLocale";
import { publicMarketingLocaleParams, type LocalizedPublicPageProps } from "@/lib/publicMarketingMetadata";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return publicMarketingLocaleParams();
}

export async function generateMetadata({ params }: LocalizedPublicPageProps): Promise<Metadata> {
  const lang = marketingLocaleFor((await params).locale);
  return lang ? helpHubMetadata(lang, true) : {};
}

export default async function Page({ params }: LocalizedPublicPageProps) {
  const lang = marketingLocaleFor((await params).locale) ?? "en";
  return (
    <LocalizedPublicPage params={params} path="/support/help-centre">
      <HelpCentreHub lang={lang} copy={helpCentreCopy(lang)} />
    </LocalizedPublicPage>
  );
}
