export const dynamic = "force-dynamic";

import { ExternalConversationViewer } from "@/components/imports/ExternalConversationViewer";
import { cookies } from "next/headers";
import { isExternalContinuationEnabled } from "@/lib/appSettings";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";

export default async function ExternalConversationViewerPage({
    params,
}: {
    params: Promise<{ conversationId: string }>;
}) {
    const { conversationId } = await params;
    /*
      Whether the "Continue in Tomverse" card is drawn at all.

      Read here rather than in the viewer for the reason `ReviewWorkspaceShell`
      reads the image-generation flag here: a Client Component cannot see the
      setting, so a client-side answer would either render the card and take it
      away, or show it for a feature the server is going to refuse. This route
      is `force-dynamic`, so the value is the one this process has now.

      A read failure leaves it false, exactly like a missing flag row -- the
      same fail-closed default the flag itself has
      (docs/policy/external-conversation-continuation.md §7). Hiding the card
      is a courtesy to the reader, never the boundary: creation is refused
      server-side with `EXTERNAL_CONTINUATION_DISABLED` whatever the browser
      was shown.
    */
    let continuationEnabled = false;
    try {
        continuationEnabled = await isExternalContinuationEnabled();
    } catch (error) {
        console.error("Failed to read the continuation flag for the viewer:", {
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
    }
    /*
      Playwright override, the same shape `ReviewWorkspaceShell` uses for the
      image-generation and voice flags: with the database disabled the flag can
      never read true, so a spec opts in per-context with a cookie. Only
      honoured in fixture mode (loopback origin + both E2E env vars), and
      production readiness fails outright if those vars are ever set there
      (lib/securityEnvironment.ts `e2eBypassDisabled`).
    */
    if (!continuationEnabled && isE2EFixtureMode()) {
        const jar = await cookies();
        continuationEnabled =
            jar.get("__tomverse_e2e_external_continuation")?.value === "1";
    }
    return (
        <main>
            <ExternalConversationViewer
                conversationId={conversationId}
                continuationEnabled={continuationEnabled}
            />
        </main>
    );
}
