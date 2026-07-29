import { notFound } from "next/navigation";
import "../globals.css";
import { DocumentShell } from "@/components/DocumentShell";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { marketingLocaleFor } from "@/lib/marketingLocale";
import { rootMetadata } from "@/lib/rootMetadata";

export const metadata = rootMetadata;

export const dynamic = "force-static";
export const revalidate = false;
export const dynamicParams = false;

/**
 * Root layout for the localized marketing routes (`/ko`, `/ko/<intent>`, ...).
 *
 * RECON-I18N-001. These pages are prerendered one file per locale and serve
 * Korean, Chinese, French, German, Spanish or Portuguese copy -- but the root
 * `<html lang>` said "en" on every one of them, because the layout that
 * rendered it sat above the `[locale]` segment and could not see the param.
 * The content itself was tagged (`<div lang="ko">`), so `:lang()` picked the
 * right font and a screen reader read the right language; what was wrong was
 * the *document's* declared language (WCAG 3.1.1), which is also what the
 * browser's "translate this page?" heuristic reads.
 *
 * A layout can only set `<html>` if it is a root layout, and a root layout can
 * only see `params` if the dynamic segment is at or below it -- so `[locale]`
 * had to become a top-level segment with a root layout of its own. That is the
 * pattern Next documents for internationalized routing. `app/layout.tsx` is
 * gone; `app/(site)/layout.tsx` is the root for everything else, and the
 * `(site)` group keeps `/pricing` and `/chat` under one root so navigation
 * between them is still client-side.
 *
 * The cost is that a link from here into `(site)` is a full document load.
 * That is inherent to separate roots, and it is measured rather than assumed
 * -- see the localized-route navigation timings in
 * .github/audits/ko-root-language-2026-07-29.md.
 */
export default async function LocalizedMarketingLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const lang = marketingLocaleFor(locale);

  // `dynamicParams = false` means only generated segments reach this layout,
  // so an unknown one is a routing defect rather than a visitor's typo --
  // but rendering `<html lang>` from an unvalidated path segment is not
  // something to leave to that guarantee.
  if (!lang) notFound();

  return (
    <DocumentShell lang={lang}>
      <MarketingShell>{children}</MarketingShell>
    </DocumentShell>
  );
}
