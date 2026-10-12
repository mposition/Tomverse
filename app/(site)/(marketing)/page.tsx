import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
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
  // Public Guest entry belongs to this static document. Account availability
  // is read privately only after the client session resolves.
  return (
    <LandingPageContent
      guestTrialAvailable={PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE}
    />
  );
}
