"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, ShieldCheck, X } from "lucide-react";
import { useModalDialog } from "@/components/useModalDialog";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminUiMessages } from "@/lib/adminMessages/ui";

/**
 * The one way the console asks before an action that is hard to undo.
 *
 * It states what changes, by how much and for whom (`summary`, `effects`)
 * before the confirm button, and says when a recent sign-in is required
 * (`stepUp`). It only asks: the caller performs the write, on the server's
 * existing route, with its own step-up and audit.
 */
export function AdminConfirmDialog({
  open,
  title,
  summary,
  effects = [],
  stepUp = false,
  confirmLabel,
  tone = "primary",
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  /** Who or what, and how much: the facts the decision rests on. */
  summary?: React.ReactNode;
  /** What will happen, one line each. */
  effects?: readonly React.ReactNode[];
  stepUp?: boolean;
  confirmLabel: string;
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
  // Initial focus on Cancel: Enter on an opened confirm must not confirm.
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
        aria-labelledby="admin-confirm-title"
        className="flex w-full max-w-lg flex-col gap-4 rounded-t-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="admin-confirm-title" className="text-lg font-bold text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={m.close}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-800"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {summary ? <div className="rounded-2xl bg-zinc-950/60 p-3 text-sm text-zinc-200">{summary}</div> : null}
        {effects.length > 0 ? (
          <ul className="flex flex-col gap-2 text-sm text-zinc-300">
            {effects.map((effect, index) => (
              <li key={index} className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                <span>{effect}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {stepUp ? (
          <p className="flex items-start gap-2 rounded-xl bg-blue-500/10 p-3 text-xs text-blue-200">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {m.stepUpNote}
          </p>
        ) : null}
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
            stepUp={stepUp}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {stepUp ? m.stepUpAction(confirmLabel) : confirmLabel}
          </AdminWriteButton>
        </div>
      </section>
    </div>,
    document.body
  );
}
