import { MarketingConsentReservation } from "@/components/analytics/MarketingConsentReservation";
import { AppToastViewport } from "@/components/AppToastViewport";
import { MarketingProviders } from "@/components/marketing/MarketingProviders";
import { StructuredData } from "@/components/seo/StructuredData";
import { SITE_NAME, SITE_ORIGIN } from "@/lib/seo";

const configuredMeasurementId = process.env.GA4_MEASUREMENT_ID?.trim();
const measurementId =
  configuredMeasurementId && /^G-[A-Z0-9]+$/.test(configuredMeasurementId)
    ? configuredMeasurementId
    : null;

/**
 * The chrome every marketing page carries: the organisation / application
 * structured data, and the marketing provider stack.
 *
 * RECON-I18N-001. This used to live directly in `app/(marketing)/layout.tsx`.
 * The localized routes moved out of that group so they could have their own
 * root layout (see components/DocumentShell.tsx), and they need the same
 * chrome -- so it is a component now instead of being copied into the second
 * layout, where the structured-data graph or the GA4 gate could have drifted
 * between the English and localized pages without anything noticing.
 */
export function MarketingShell({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {/* First thing in the marketing subtree, so it runs before the header --
          and therefore the consent slot -- is parsed. */}
      <MarketingConsentReservation />
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
        {/*
          UX-006. Inside the providers, because the viewport reads its dismiss
          label from LanguageProvider. Marketing, the admin console and the chat
          shell never render together, so an event is still announced exactly
          once.
        */}
        <AppToastViewport />
      </MarketingProviders>
    </>
  );
}
