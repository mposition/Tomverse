
"use client";
import type { ReactNode } from "react";
import { useAdminMessages } from "./AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
export function AmuxExecutionSupportingRecords({ children }: { children: ReactNode }) {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  return <details className="rounded-lg border p-4 border-zinc-700">
    <summary className="cursor-pointer text-sm font-medium">{m.supportingRecords}</summary>
    <div className="mt-4 flex min-w-0 flex-col gap-5">{children}</div>
  </details>;
}

