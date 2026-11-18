import { HelpCentreHub } from "@/components/help/HelpCentreHub";
import { helpCentreCopy } from "@/lib/helpCentre/copy";
import { helpHubMetadata } from "@/lib/helpCentre/metadata";

export const metadata = helpHubMetadata("en", false);

export default function HelpCentrePage() {
  return <HelpCentreHub lang="en" copy={helpCentreCopy("en")} />;
}
