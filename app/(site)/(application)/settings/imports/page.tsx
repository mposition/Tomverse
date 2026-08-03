export const dynamic = "force-dynamic";

import { ExternalImportManagement } from "@/components/imports/ExternalImportManagement";

// Route layout under /settings/imports:
//
//   page.tsx                      this management screen
//   new/page.tsx                  the full-screen wizard  (static segment)
//   [importId]/page.tsx           one run's detail        (dynamic segment)
//   conversations/[id]/page.tsx   the read-only viewer    (static segment)
//
// The static `new` and `conversations` segments deliberately sit alongside
// the dynamic `[importId]`: App Router matches a literal segment before a
// dynamic one, so /settings/imports/new is always the wizard and can never be
// swallowed as an import id. Nothing else may be added under this folder with
// a name an import id could take.
//
// Availability is not resolved here: the capacity endpoint is the
// authoritative flag/session probe, which keeps the rendered state and the
// API's fail-closed behaviour identical by construction (policy §15).
export default function ImportSettingsPage() {
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <ExternalImportManagement />
        </main>
    );
}
