import LaunchHomepage from "@/components/marketing/LaunchHomepage";
import { homepageProductLinks } from "@/lib/homepageProductLinks";
import { MarketingChatAvailabilityProvider } from "@/components/marketing/MarketingChatAvailability";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import { createPageMetadata, getHomeOgCopy, getHomeSeoCopy } from "@/lib/seo";

const seoCopy = getHomeSeoCopy("en", PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);
const ogCopy = getHomeOgCopy("en", PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);

export const metadata = createPageMetadata({
  title: seoCopy.title,
  description: seoCopy.description,
  path: "/",
  localizedBasePath: "/",
  ogTitle: ogCopy.title,
  ogDescription: ogCopy.description,
});

export default function LandingPage() {
  return (
    <MarketingChatAvailabilityProvider guestTrialAvailable={PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE}>
      <LaunchHomepage {...homepageProductLinks("en")} />
    </MarketingChatAvailabilityProvider>
  );
}
