"use client";

import { Info, Loader2, Save } from "lucide-react";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";

/**
 * The one place a screen with an editable draft saves from.
 *
 * It is drawn only while there is something unsaved, sticks to the bottom of
 * the page, and offers exactly two things: put the values back (`onRevert`,
 * local only) and open the review (`onReview`). It never writes: the caller
 * opens an `AdminConfirmDialog` from `onReview` and performs the save on its
 * existing route after the operator confirms, so there is no second save
 * button that skips the review.
 *
 * Copy comes in through props because it belongs to the screen that owns the
 * draft, not to the shared primitives.
 */
export function AdminSaveBar({
  regionLabel,
  title,
  detail,
  revertLabel,
  reviewLabel,
  onRevert,
  onReview,
  busy = false,
  writable = true,
  requiredRole,
}: {
  /** Names the landmark for screen readers. */
  regionLabel: string;
  /** "3 unsaved changes". */
  title: React.ReactNode;
  detail?: React.ReactNode;
  revertLabel: string;
  reviewLabel: string;
  onRevert: () => void;
  onReview: () => void;
  busy?: boolean;
  writable?: boolean;
  requiredRole?: string;
}) {
  return (
    <div
      role="region"
      aria-label={regionLabel}
      data-testid="admin-save-bar"
      className="sticky bottom-4 z-30 flex flex-col gap-3 rounded-2xl border border-zinc-700 bg-zinc-800 p-3 shadow-2xl sm:flex-row sm:items-center sm:justify-between sm:px-5"
    >
      <p className="flex min-w-0 items-start gap-2 text-sm text-zinc-300">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" aria-hidden />
        <span className="min-w-0">
          <span className="font-bold text-white">{title}</span>
          {detail ? <span className="ml-2 text-zinc-400">{detail}</span> : null}
        </span>
      </p>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          onClick={onRevert}
          disabled={busy}
          className="min-h-10 rounded-xl px-3 text-sm font-bold text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {revertLabel}
        </button>
        <AdminWriteButton
          writable={writable}
          requiredRole={requiredRole}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onReview}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
          {reviewLabel}
        </AdminWriteButton>
      </div>
    </div>
  );
}
