export const dynamic = "force-dynamic";

import { ExternalApiSettings } from "@/components/settings/ExternalApiSettings";

// Route shell only. Availability, keys, models and client configuration all
// come from /api/user/api-keys, which is also the session probe.
export default function ExternalApiSettingsPage() {
    return (
        <main>
            <ExternalApiSettings />
        </main>
    );
}
