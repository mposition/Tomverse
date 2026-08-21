export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { AssistantProfileList } from "@/components/assistants/AssistantProfileList";

// Route shell only. Availability is resolved by the API itself: the list
// endpoint is the probe, and a 403 turns the page into the disabled notice --
// the same split /settings/memory uses, so the flag rule has one home
// (policy §15).
export default function AssistantProfilesPage() {
    return (
        <main>
            {/*
              The list reads the query string to know which row to restore on
              the way back from a profile. `useSearchParams` suspends during
              prerendering; this route is `force-dynamic` so it does not here,
              and the boundary keeps that true if the rendering mode ever
              changes.
            */}
            <Suspense fallback={null}>
                <AssistantProfileList />
            </Suspense>
        </main>
    );
}
