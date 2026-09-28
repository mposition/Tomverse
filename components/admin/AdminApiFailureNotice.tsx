"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminCommonMessages } from "@/lib/adminMessages/common";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

/**
 * One place a refused admin request is shown, so every panel says the same
 * thing about the same answer.
 *
 * Three answers, three treatments, and the reason they cannot be one:
 *
 * - **Queued for approval (409).** Not a failure. The request is stored and a
 *   second administrator has to approve that exact payload. Rendered as
 *   information, with the approval id, because an operator told "failed" here
 *   retries a request that has already been accepted.
 * - **Step-up required (428).** Their sign-in is no longer recent enough.
 *   Rendered with a link into the step-up flow carrying a callback to this
 *   screen -- `docs/ui-contracts/admin-console-ia.md` rule 7, because a toast
 *   naming the remedy and giving no way to reach it has now been shipped three
 *   times and reads as a broken screen rather than a gated one.
 * - **Everything else.** An error, with whatever the server said.
 *
 * The callback path comes from `usePathname()` rather than a prop: it is the
 * screen the operator is actually on, and a prop is a second place for it to
 * be wrong.
 */
export function AdminApiFailureNotice({
  failure,
  onRetry,
  testId,
}: {
  failure: AdminApiFailure;
  /** Rendered as a retry control when the caller can repeat the request. */
  onRetry?: () => void;
  testId?: string;
}) {
  const m = useAdminMessages(adminCommonMessages).apiFailure;
  const pathname = usePathname();

  if (failure.requiresReauthentication) {
    return (
      <div
        role="alert"
        data-testid={testId ?? "admin-api-reauthentication"}
        className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-bold text-amber-100">
          <Clock className="h-4 w-4 shrink-0" aria-hidden />
          {m.reauthenticationTitle}
        </p>
        <p className="mt-1 text-xs leading-5 text-amber-100/80">
          {failure.message}
        </p>
        <Link
          href={adminRecentAuthenticationHref(pathname)}
          data-testid="admin-api-reauthenticate-link"
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-xs font-bold text-amber-100 hover:bg-amber-500/20"
        >
          {m.reauthenticate}
        </Link>
      </div>
    );
  }

  const queued = failure.approvalId !== null;
  return (
    <div
      role={queued ? "status" : "alert"}
      data-testid={testId ?? (queued ? "admin-api-queued" : "admin-api-error")}
      className={`mt-3 rounded-2xl border p-4 ${
        queued
          ? "border-blue-500/30 bg-blue-500/10"
          : "border-red-500/30 bg-red-500/10"
      }`}
    >
      <p
        className={`flex items-center gap-2 text-sm font-bold ${
          queued ? "text-blue-100" : "text-red-100"
        }`}
      >
        {queued ? null : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />}
        {queued ? m.queuedTitle : m.errorTitle}
      </p>
      <p
        className={`mt-1 text-xs leading-5 ${
          queued ? "text-blue-100/80" : "text-red-100/80"
        }`}
      >
        {failure.message}
      </p>
      {onRetry && !queued ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="admin-api-retry"
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-100 hover:bg-red-500/20"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {m.retry}
        </button>
      ) : null}
    </div>
  );
}
