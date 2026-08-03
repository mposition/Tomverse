export const dynamic = "force-dynamic";

import { ExternalImportDetail } from "@/components/imports/ExternalImportDetail";

export default async function ImportDetailPage({
    params,
}: {
    params: Promise<{ importId: string }>;
}) {
    const { importId } = await params;
    return (
        <main className="min-h-dvh bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <ExternalImportDetail importId={importId} />
        </main>
    );
}
