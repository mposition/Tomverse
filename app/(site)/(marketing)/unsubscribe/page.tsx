import { createPageMetadata } from "@/lib/seo";
import { LanguageProvider } from "@/components/LanguageProvider";
import { UnsubscribeConfirmation } from "@/components/email/UnsubscribeConfirmation";

export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
    title: "Unsubscribe",
    description: "Stop receiving a kind of email from Tomverse.",
    path: "/unsubscribe",
    noIndex: true,
});

/**
 * Where an unsubscribe link lands.
 *
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §11.3.
 *
 * The page itself changes nothing. Mail clients and security appliances
 * prefetch links, so a page that unsubscribed on load would unsubscribe people
 * who never clicked -- and they would find out by not receiving something.
 * The button posts; this only shows it.
 *
 * One click from here completes it, which is what CAN-SPAM's "a single page
 * visit" and the Australian rule against extra steps both allow.
 */
export default async function UnsubscribePage({
    searchParams,
}: {
    searchParams: Promise<{ t?: string }>;
}) {
    const { t } = await searchParams;
    // The provider is mounted here rather than inherited: marketing pages in
    // this segment each bring their own, and this one has to render for
    // somebody who may not be signed in and may never have visited before.
    return (
        <LanguageProvider>
            <UnsubscribeConfirmation token={t ?? ""} />
        </LanguageProvider>
    );
}
