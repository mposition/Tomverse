export const dynamic = "force-dynamic";

import { ExternalImportDetail } from "@/components/imports/ExternalImportDetail";

export default async function ImportDetailPage({
    params,
}: {
    params: Promise<{ importId: string }>;
}) {
    const { importId } = await params;
    return (
        <main>
            <ExternalImportDetail importId={importId} />
        </main>
    );
}
