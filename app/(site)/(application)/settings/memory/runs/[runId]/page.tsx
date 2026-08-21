export const dynamic = "force-dynamic";

import { MemoryExtractionRunStatus } from "@/components/memory/MemoryExtractionRunStatus";

// Route shell only. Ownership is the API's to decide: a run belonging to
// another account is a 404 there, and this page renders whatever that answers
// rather than pre-judging access (policy §21).
export default async function MemoryExtractionRunPage({
    params,
}: PageProps<"/settings/memory/runs/[runId]">) {
    const { runId } = await params;
    return (
        <main>
            <MemoryExtractionRunStatus runId={runId} />
        </main>
    );
}
