"use client";

import { useRouter } from "next/navigation";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";

/**
 * What a server-rendered page shows when its read failed. A server component
 * cannot hand a retry function down, so the retry lives here: it asks the
 * server to render the page again. The failure is never drawn as an empty
 * list.
 */
export function AdminReadFailed({ title, detail }: { title: string; detail?: string }) {
  const router = useRouter();
  return <AdminStateBlock kind="error" title={title} detail={detail} onRetry={() => router.refresh()} />;
}
