import type { Metadata } from "next";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { LocalizedPublicPage } from "@/components/marketing/LocalizedPublicPage";
import { localizedPublicPageMetadata, publicMarketingLocaleParams, type LocalizedPublicPageProps } from "@/lib/publicMarketingMetadata";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return publicMarketingLocaleParams();
}

export async function generateMetadata(props: LocalizedPublicPageProps): Promise<Metadata> {
  return localizedPublicPageMetadata(props, "/safety");
}

export default function Page({ params }: LocalizedPublicPageProps) {
  return <LocalizedPublicPage params={params} path="/safety"><MarketingInfoPage content={infoPages.safety} /></LocalizedPublicPage>;
}
