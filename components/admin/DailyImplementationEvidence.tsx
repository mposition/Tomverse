"use client";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminDailyProductImplementationMessages } from "@/lib/adminMessages/dailyProductImplementation";
import type { DailyTaskImplementation } from "@/lib/dailyProductImplementationCore";

export function DailyImplementationEvidence({ implementation, unavailable = false }: {
  implementation?: DailyTaskImplementation; unavailable?: boolean;
}) {
  const labels = useAdminMessages(adminDailyProductImplementationMessages);
  if (!implementation && !unavailable) return null;
  return <p className="mt-1 text-xs text-zinc-400" data-testid="daily-implementation-evidence">
    {implementation ? <a className="text-blue-300 hover:text-blue-200" href={implementation.prUrl} target="_blank" rel="noreferrer">{labels[implementation.state]}</a> : labels.unavailable}
  </p>;
}
