"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/components/useModalDialog";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminUiMessages } from "@/lib/adminMessages/ui";

/**
 * A confirm dialog that asks for something first: a reason, a note, a choice.
 *
 * `AdminConfirmDialog` only states facts and asks yes or no. This one has the
 * same frame and the same rules (focus starts on Cancel, the page behind is
 * inert, the caller performs the write) and holds the caller's fields in
 * `children`. `confirmDisabled` keeps the confirm button off until the fields
 * are complete without also disabling Cancel, which `busy` does.
 */
export function AdminReasonDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  confirmDisabled = false,
  tone = "primary",
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { locale } = useAdminLocale();
  const m = useAdminMessages(adminUiMessages);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useModalDialog({ open, onClose, dialogRef, panelRef: dialogRef, initialFocusRef: cancelRef });

  useEffect(() => {
    if (!open) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const siblings = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay
    );
    const previous = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    return () => {
      siblings.forEach((element, index) => {
        element.inert = previous[index];
      });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={overlayRef}
      lang={locale}
      data-locale-root
      className="fixed inset-0 z-[150] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-reason-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="admin-reason-title" className="text-lg font-bold text-white">
              {title}
            </h2>
            {description ? <p className="mt-1 text-sm text-zinc-400">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={m.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-800"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-10 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
          >
            {m.cancel}
          </button>
          <AdminWriteButton
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AdminWriteButton>
        </div>
      </section>
    </div>,
    document.body
  );
}
