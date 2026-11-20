import { LegalInfoDocument } from "@/components/marketing/v2/policy/LegalDocumentPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { withLegalSectionNav } from "@/lib/legalSectionNav";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Refund Policy",
  description:
    "Tomverse refund eligibility, billing correction, cancellation, and support request guidance.",
  path: "/refund",
});

export default function RefundPage() {
  return <LegalInfoDocument document="refund" content={withLegalSectionNav(infoPages.refund)} />;
}
