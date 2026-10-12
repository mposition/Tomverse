import type { Metadata } from "next";
import { SupportPageContent } from "@/components/marketing/SupportPageContent";
import { LocalizedPublicPage } from "@/components/marketing/LocalizedPublicPage";
import { localizedPublicPageMetadata, publicMarketingLocaleParams, type LocalizedPublicPageProps } from "@/lib/publicMarketingMetadata";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return publicMarketingLocaleParams();
}

export async function generateMetadata(props: LocalizedPublicPageProps): Promise<Metadata> {
  return localizedPublicPageMetadata(props, "/support");
}

export default function Page({ params }: LocalizedPublicPageProps) {
  return <LocalizedPublicPage params={params} path="/support"><SupportPageContent /></LocalizedPublicPage>;
}
