export const dynamic = "force-dynamic";

import { AssistantProfileEditor } from "@/components/assistants/AssistantProfileEditor";

export default async function AssistantProfilePage({
    params,
}: {
    params: Promise<{ profileId: string }>;
}) {
    const { profileId } = await params;
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <AssistantProfileEditor profileId={profileId} />
        </main>
    );
}
