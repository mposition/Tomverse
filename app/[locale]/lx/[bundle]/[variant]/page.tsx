import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LanguageProvider } from "@/components/LanguageProvider";
import LaunchHomepage from "@/components/marketing/LaunchHomepage";
import { LandingExperimentBeacon } from "@/components/marketing/LandingExperimentBeacon";
import {
  landingExperimentStaticParams,
  landingVariantCopy,
} from "@/components/marketing/landingExperimentBundles";
import { homepageProductLinks } from "@/lib/homepageProductLinks";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import {
  createPageMetadata,
  getHomeSeoCopy,
  isSeoLocale,
  localizedPath,
} from "@/lib/seo";

/**
 * A landing experiment variant (docs/policy/marketing-automation.md 9.1).
 *
 * Prerendered at build time, one file per bundle, variant and locale, exactly
 * like the default home page, and never indexed: the proxy rewrites a home
 * request to this path for a visitor whose assignment cookie names the
 * variant, and nobody else is supposed to land here. The words come from
 * `landingExperimentBundles.ts`, never from a setting.
 */

type VariantPageProps = {
  params: Promise<{ locale: string; bundle: string; variant: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return landingExperimentStaticParams();
}

export async function generateMetadata({
  params,
}: VariantPageProps): Promise<Metadata> {
  const { locale, bundle, variant } = await params;
  if (!isSeoLocale(locale) || !landingVariantCopy(bundle, variant, locale)) {
    return {};
  }
  const seo = getHomeSeoCopy(locale, PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE);
  return createPageMetadata({
    title: seo.title,
    description: seo.description,
    // The canonical page is the default home; a variant is never a page of its own.
    path: localizedPath(locale, "/"),
    locale,
    absoluteTitle: true,
    noIndex: true,
  });
}

export default async function LandingExperimentVariantPage({
  params,
}: VariantPageProps) {
  const { locale, bundle, variant } = await params;
  const copy = landingVariantCopy(bundle, variant, locale);
  if (!isSeoLocale(locale) || !copy) notFound();

  return (
    <div lang={locale}>
      <LanguageProvider initialLang={locale} forceInitialLang>
        <LaunchHomepage {...homepageProductLinks(locale)} variantCopy={copy} />
        <LandingExperimentBeacon renderedArm={variant} locale={locale} />
      </LanguageProvider>
    </div>
  );
}
