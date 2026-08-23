export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";

import { AssistantPackageImportWizard } from "@/components/assistants/import/AssistantPackageImportWizard";
import { isAssistantPackageImportEnabled } from "@/lib/appSettings";
import { listAssistantProfiles } from "@/lib/assistantProfileService";
import { authOptions } from "@/lib/auth";
import type { ImportMergeTarget } from "@/lib/assistantPackageImportWizard";

// /settings/assistants/import — the full-screen package import wizard.
//
// docs/policy/assistant-package-import.md §5.1, §11.
//
// `import` is a static segment beside `[profileId]` and `new`, the same shape
// /settings/imports/new already uses. The App Router resolves the literal
// first, so this is never a profile whose id happens to be "import".
//
// The flag is read here rather than probed through an API, which is the
// opposite of what /settings/assistants does — and deliberately. That page's
// list endpoint answers the question anyway, so the page can stay a shell.
// This wizard's own endpoints only exist from step 7 onward: steps 1 to 6 are
// entirely client-side by design (§5.2), so a missing flag has nothing to 403
// before then. It is therefore answered here, and answered with 404 rather
// than a disabled screen: a route that renders "not available yet" announces
// an unreleased feature to anyone who guesses the URL, and gives the person
// who found it nothing to do.
//
// The merge targets are read here too, for the same reason in reverse. Step 6
// offers the owner's existing assistants, and fetching that list from the
// browser would put a request inside the stretch of the wizard whose whole
// contract is that no request has gone out yet (§5.4) — which is what makes
// cancelling before step 7 mean "there is nothing to undo". Read on the server
// it is a prop, and the invariant holds. Nothing here decides anything: the
// id is all that is sent, and the server reads the target's own revision and
// identity again when the import is created and again when it publishes.
export default async function AssistantPackageImportPage() {
    if (!(await isAssistantPackageImportEnabled())) notFound();
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    const mergeTargets: ImportMergeTarget[] = userId
        ? (await listAssistantProfiles(userId)).map((profile) => ({
              id: profile.id,
              name: profile.name,
              icon: profile.icon,
              currentRevision: profile.currentRevision,
              knowledgeFileCount: profile.knowledgeFileCount,
          }))
        : [];
    return (
        <main>
            <AssistantPackageImportWizard mergeTargets={mergeTargets} />
        </main>
    );
}
