export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";

import { AssistantPackageImportWizard } from "@/components/assistants/import/AssistantPackageImportWizard";
import { isAssistantPackageImportEnabled } from "@/lib/appSettings";

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
// This wizard has no endpoint of its own yet: steps 1 to 6 are entirely
// client-side by design (§5.2), so there is nothing to 403. A missing flag
// therefore has to be answered here, and it is answered with 404 rather than
// a disabled screen: a route that renders "not available yet" announces an
// unreleased feature to anyone who guesses the URL, and gives the person who
// found it nothing to do.
export default async function AssistantPackageImportPage() {
    if (!(await isAssistantPackageImportEnabled())) notFound();
    return (
        <main>
            <AssistantPackageImportWizard />
        </main>
    );
}
