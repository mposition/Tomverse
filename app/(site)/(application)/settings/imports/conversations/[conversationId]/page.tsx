export const dynamic = "force-dynamic";

import { ExternalConversationViewer } from "@/components/imports/ExternalConversationViewer";

export default async function ExternalConversationViewerPage({
    params,
}: {
    params: Promise<{ conversationId: string }>;
}) {
    const { conversationId } = await params;
    return (
        <main>
            <ExternalConversationViewer conversationId={conversationId} />
        </main>
    );
}
