import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { createPageMetadata, homeSeoCopy } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: homeSeoCopy.en.title,
  description: homeSeoCopy.en.description,
  path: "/",
  localizedBasePath: "/",
});

export default function LandingPage() {
  return <LandingPageContent />;
}
