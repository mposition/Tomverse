export const dynamic = "force-dynamic";

import { ExternalImportSettings } from "@/components/imports/ExternalImportSettings";

// The wizard is fully client-driven (Web Worker parsing, staged uploads), so
// this Server Component is only the route shell. Availability is not resolved
// here: the capacity endpoint is the authoritative flag/session probe, which
// keeps the rendered state and the API's fail-closed behaviour identical by
// construction (policy §15).
export default function ImportSettingsPage() {
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <ExternalImportSettings />
        </main>
    );
}
