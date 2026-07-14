import { MarketingProviders } from "@/components/marketing/MarketingProviders";
import { StructuredData } from "@/components/seo/StructuredData";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";

export const dynamic = "force-static";
export const revalidate = false;

const configuredMeasurementId = process.env.GA4_MEASUREMENT_ID?.trim();
const measurementId =
  configuredMeasurementId && /^G-[A-Z0-9]+$/.test(configuredMeasurementId)
    ? configuredMeasurementId
    : null;

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              "@id": `${SITE_ORIGIN}/#organization`,
              name: SITE_NAME,
              url: SITE_ORIGIN,
              logo: `${SITE_ORIGIN}/tomverse-logo.png`,
            },
            {
              "@type": "SoftwareApplication",
              "@id": `${SITE_ORIGIN}/#software-application`,
              name: SITE_NAME,
              url: SITE_ORIGIN,
              description:
                "A multi-model AI workspace for comparing answers, analyzing files, and organizing conversations.",
              applicationCategory: "BusinessApplication",
              applicationSubCategory: "Artificial intelligence workspace",
              operatingSystem: "Any modern web browser",
              isAccessibleForFree: true,
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              publisher: { "@id": `${SITE_ORIGIN}/#organization` },
            },
          ],
        }}
      />
      <MarketingProviders measurementId={measurementId}>
        {children}
      </MarketingProviders>
    </>
  );
}
