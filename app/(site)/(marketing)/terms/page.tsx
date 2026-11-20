import { LegalInfoDocument } from "@/components/marketing/v2/policy/LegalDocumentPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { withLegalSectionNav } from "@/lib/legalSectionNav";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Terms and Conditions",
  description:
    "Read the terms governing accounts, acceptable use, AI outputs, third-party providers, paid plans, and access to Tomverse.",
  path: "/terms",
});

export default function TermsPage() {
  return <LegalInfoDocument document="terms" content={withLegalSectionNav(infoPages.terms)} />;
}
