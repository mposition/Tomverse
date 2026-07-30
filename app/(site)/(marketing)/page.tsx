import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { createPageMetadata, homeOgCopy, homeSeoCopy } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: homeSeoCopy.en.title,
  description: homeSeoCopy.en.description,
  path: "/",
  localizedBasePath: "/",
  ogTitle: homeOgCopy.en.title,
  ogDescription: homeOgCopy.en.description,
});

export default function LandingPage() {
  return <LandingPageContent />;
}
