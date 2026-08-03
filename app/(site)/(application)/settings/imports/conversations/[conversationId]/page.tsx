export const dynamic = "force-dynamic";

import { ExternalConversationViewer } from "@/components/imports/ExternalConversationViewer";

export default async function ExternalConversationViewerPage({
    params,
}: {
    params: Promise<{ conversationId: string }>;
}) {
    const { conversationId } = await params;
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <ExternalConversationViewer conversationId={conversationId} />
        </main>
    );
}
