import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { landingChatSurfaceAvailable } from "@/lib/landingWorkspaceEntry";
import { createPageMetadata, homeOgCopy, homeSeoCopy } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: homeSeoCopy.en.title,
  description: homeSeoCopy.en.description,
  path: "/",
  localizedBasePath: "/",
  ogTitle: homeOgCopy.en.title,
  ogDescription: homeOgCopy.en.description,
});

export default async function LandingPage() {
  // The CTA's destination is decided here, per visitor, rather than by the
  // client reading a flag it is not allowed to have (decision record v1.2 §3).
  const { chatSurfaceAvailable } = await landingChatSurfaceAvailable();
  return <LandingPageContent chatSurfaceAvailable={chatSurfaceAvailable} />;
}
