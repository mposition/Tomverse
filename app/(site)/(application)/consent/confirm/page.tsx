import { createPageMetadata } from "@/lib/seo";
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
 *
 * The token is in the URL fragment (`#t=`), which the browser never sends to
 * the server, so this page receives nothing to read and the component takes it
 * from `location.hash`. The page is in the (application) group because that
 * layout is dynamic: a prerendered page under the static marketing layout gets
 * no CSP nonce in production and could not hydrate. The (application) layout
 * supplies the language provider.
 */
export default function ConsentConfirmPage() {
    return <ConsentConfirmation />;
}
