export const dynamic = "force-dynamic";

import { AssistantProfileEditor } from "@/components/assistants/AssistantProfileEditor";

export default async function AssistantProfilePage({
    params,
}: {
    params: Promise<{ profileId: string }>;
}) {
    const { profileId } = await params;
    return (
        <main>
            <AssistantProfileEditor profileId={profileId} />
        </main>
    );
}
