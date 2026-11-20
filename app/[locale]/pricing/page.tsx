import type { Metadata } from "next";
import { PricingPage } from "@/components/marketing/v2/pricing/PricingPage";
import { LocalizedPublicPage } from "@/components/marketing/LocalizedPublicPage";
import { localizedPublicPageMetadata, publicMarketingLocaleParams, type LocalizedPublicPageProps } from "@/lib/publicMarketingMetadata";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return publicMarketingLocaleParams();
}

export async function generateMetadata(props: LocalizedPublicPageProps): Promise<Metadata> {
  return localizedPublicPageMetadata(props, "/pricing");
}

export default function Page({ params }: LocalizedPublicPageProps) {
  return <LocalizedPublicPage params={params} path="/pricing"><PricingPage /></LocalizedPublicPage>;
}
