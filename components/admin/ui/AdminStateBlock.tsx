"use client";

import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminUiMessages } from "@/lib/adminMessages/ui";

/**
 * The three states a list or panel can be in besides "has rows".
 *
 * - `error`: the read failed. Says so in red and offers a retry; it is never
 *   drawn as an empty list (IA contract: a failed read is never shown empty).
 * - `empty`: the read succeeded and there is nothing to do.
 * - `loading`: skeleton lines in the shape of the content.
 */
export function AdminStateBlock({
  kind,
  title,
  detail,
  onRetry,
  illustration,
}: {
  kind: "error" | "empty" | "loading";
  title?: React.ReactNode;
  detail?: React.ReactNode;
  onRetry?: () => void;
  /** Optional art on the left, for example an agent's pixel avatar. */
  illustration?: React.ReactNode;
}) {
  const m = useAdminMessages(adminUiMessages);
  if (kind === "loading") {
    return (
      <div role="status" aria-label={m.loading} className="flex items-center gap-3 rounded-2xl border border-zinc-800 p-4">
        <span className="h-11 w-11 shrink-0 animate-pulse rounded-xl bg-zinc-800" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-2.5 w-3/5 animate-pulse rounded bg-zinc-800" />
          <span className="h-2.5 w-4/5 animate-pulse rounded bg-zinc-800" />
        </span>
      </div>
    );
  }
  const error = kind === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      className={`flex items-center gap-3 rounded-2xl p-4 text-sm ${
        error ? "bg-red-500/10 text-red-200" : "border border-dashed border-zinc-700 text-zinc-300"
      }`}
    >
      {illustration ??
        (error ? (
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-300" aria-hidden />
        ) : (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
        ))}
      <div className="min-w-0 flex-1">
        {title ? <p className={`font-bold ${error ? "text-red-200" : "text-zinc-100"}`}>{title}</p> : null}
        {detail ? <p className="mt-0.5 text-xs text-zinc-400">{detail}</p> : null}
      </div>
      {error && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {m.retry}
        </button>
      ) : null}
    </div>
  );
}
