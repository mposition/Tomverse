export const dynamic = "force-dynamic";

import { MemoryReviewSettings } from "@/components/memory/MemoryReviewSettings";

// Route shell only. Availability is resolved by the APIs themselves: the
// settings endpoint is the session probe, and review mutations answer
// MEMORY_FEATURE_DISABLED when the rollout flag is off — the list and
// delete stay reachable so a rollback never strands reviewed memories
// (policy §15).
export default function MemorySettingsPage() {
    return (
        <main>
            <MemoryReviewSettings />
        </main>
    );
}
