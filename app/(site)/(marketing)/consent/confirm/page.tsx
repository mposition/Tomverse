import { createPageMetadata } from "@/lib/seo";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ConsentConfirmation } from "@/components/email/ConsentConfirmation";

export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
    title: "Confirm email subscription",
    description: "Confirm that you want to receive this kind of email from Tomverse.",
    path: "/consent/confirm",
    noIndex: true,
});

/**
 * Where a consent confirmation link lands.
 *
 * Contract: docs/policy/email-double-opt-in.md §3 rule 4, §5 step 4.
 *
 * The page itself changes nothing. Mail scanners prefetch links, and a page
 * that confirmed on load would turn a scanner's visit into a consent. The
 * button posts; this only shows it.
 */
export default async function ConsentConfirmPage({
    searchParams,
}: {
    searchParams: Promise<{ t?: string }>;
}) {
    const { t } = await searchParams;
    return (
        <LanguageProvider>
            <ConsentConfirmation token={t ?? ""} />
        </LanguageProvider>
    );
}
