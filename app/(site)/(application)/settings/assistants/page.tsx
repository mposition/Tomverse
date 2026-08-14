export const dynamic = "force-dynamic";

import { AssistantProfileList } from "@/components/assistants/AssistantProfileList";

// Route shell only. Availability is resolved by the API itself: the list
// endpoint is the probe, and a 403 turns the page into the disabled notice --
// the same split /settings/memory uses, so the flag rule has one home
// (policy §15).
export default function AssistantProfilesPage() {
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <AssistantProfileList />
        </main>
    );
}
