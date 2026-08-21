export const dynamic = "force-dynamic";

import { AccountDataDownload } from "@/components/privacy/AccountDataDownload";

// Route shell only. Whether the visitor may download anything is decided by
// the API -- the session, the step-up and the rate limit all live there -- so
// this page renders the same for everyone and never has to duplicate a rule it
// could get wrong.
export default function AccountDataSettingsPage() {
    return (
        <main>
            <AccountDataDownload />
        </main>
    );
}
