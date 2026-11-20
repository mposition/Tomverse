import type { Metadata } from "next";
import { SafetyPage } from "@/components/marketing/v2/policy/SafetyPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { policyDocumentCards } from "@/components/marketing/v2/policy/policyDocumentCards";
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
  return <LocalizedPublicPage params={params} path="/safety"><SafetyPage content={infoPages.safety} documents={policyDocumentCards()} /></LocalizedPublicPage>;
}
