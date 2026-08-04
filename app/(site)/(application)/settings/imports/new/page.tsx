export const dynamic = "force-dynamic";

import { ExternalImportWizard } from "@/components/imports/ExternalImportWizard";

// /settings/imports/new — the full-screen import wizard.
//
// `new` is a static segment sharing a parent with the dynamic `[importId]`
// segment; the App Router resolves the literal first, so this page always
// wins over an import id that happened to be the string "new". The wizard is
// a page rather than a modal on purpose: it is a five-step task with a long
// virtualized list, and the settings modal has no room for it (policy §21).
//
// It is fully client-driven — Web Worker parsing, staged uploads — so this
// Server Component is only the route shell.
export default function NewImportPage() {
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <ExternalImportWizard />
        </main>
    );
}
