import { HelpCentreHub } from "@/components/help/HelpCentreHub";
import { helpCentreCopy } from "@/lib/helpCentre/copy";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/support/help-centre");

export default function HelpCentrePage() {
  return <HelpCentreHub lang="en" copy={helpCentreCopy("en")} />;
}
