import LaunchHomepage from "@/components/marketing/LaunchHomepage";
import { homepageProductLinks } from "@/lib/homepageProductLinks";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import { createPageMetadata, getHomeOgCopy, getHomeSeoCopy } from "@/lib/seo";

const seoCopy = getHomeSeoCopy("en", PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);
const ogCopy = getHomeOgCopy("en", PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);

export const metadata = createPageMetadata({
  title: seoCopy.title,
  description: seoCopy.description,
  path: "/",
  localizedBasePath: "/",
  absoluteTitle: true,
  ogTitle: ogCopy.title,
  ogDescription: ogCopy.description,
});

export default function LandingPage() {
  return <LaunchHomepage {...homepageProductLinks("en")} />;
}
