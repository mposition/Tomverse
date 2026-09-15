import { createPageMetadata } from "@/lib/seo";
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
 * Contract: docs/policy/email-notifications.md §11.3.
 *
 * The page itself changes nothing. Mail clients and security appliances
 * prefetch links, so a page that unsubscribed on load would unsubscribe people
 * who never clicked -- and they would find out by not receiving something.
 * The button posts; this only shows it.
 *
 * One click from here completes it, which is what CAN-SPAM's "a single page
 * visit" and the Australian rule against extra steps both allow.
 *
 * ## Why this lives in the (application) group
 *
 * It used to sit under (marketing), whose layout is `force-static`. That made
 * the server `searchParams` below always empty, so every link rendered "no
 * longer valid"; and because the page was prerendered but is not a listed
 * static marketing path, production's nonce CSP had no nonce for its scripts,
 * so a client-side fix could not hydrate either. A dynamic page reads the
 * token on the server and gets a per-request nonce like every other dynamic
 * route. The URL is unchanged -- route groups do not appear in it -- so links
 * already in inboxes keep working. The one-click `POST` to this URL is
 * rewritten to `/api/unsubscribe` by `proxy.ts`, because a page cannot answer a
 * `POST`. The (application) layout supplies the language provider.
 */
export default async function UnsubscribePage({
    searchParams,
}: {
    searchParams: Promise<{ t?: string }>;
}) {
    const { t } = await searchParams;
    return <UnsubscribeConfirmation token={t ?? ""} />;
}
