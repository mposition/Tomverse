export const dynamic = "force-dynamic";

import { EmailNotificationSettings } from "@/components/email/EmailNotificationSettings";

// Route shell only. Everything it needs -- the preferences, whether the
// jurisdiction is confirmed, and which rows cannot be switched off -- comes
// from /api/user/email-preferences, which is also the session probe.
export default function EmailNotificationSettingsPage() {
    return (
        <main>
            <EmailNotificationSettings />
        </main>
    );
}
