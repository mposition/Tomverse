export const dynamic = "force-dynamic";

import { AssistantProfileEditor } from "@/components/assistants/AssistantProfileEditor";
import { isAssistantKnowledgeEnabled } from "@/lib/appSettings";

export default async function AssistantProfilePage({
    params,
}: {
    params: Promise<{ profileId: string }>;
}) {
    const { profileId } = await params;
    // Resolved here rather than discovered by the client. The knowledge panel
    // used to learn the flag by calling its own endpoint and reading the 403,
    // which meant every visit with the flag off logged a failed request to the
    // console -- an error the reader did not cause and cannot act on. The
    // server already knows, so it says.
    const knowledgeEnabled = await isAssistantKnowledgeEnabled();
    return (
        <main>
            <AssistantProfileEditor
                profileId={profileId}
                knowledgeEnabled={knowledgeEnabled}
            />
        </main>
    );
}
