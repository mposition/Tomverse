"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { lockBodyScroll } from "@/components/useBodyScrollLock";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";

type Messages = (typeof adminAmuxIdeaInputMessages)["en"];

/** `working` while the request is in flight; the three others once it has settled. */
export type AmuxBusyTone = "working" | "success" | "partial" | "refused" | "unknown";

/**
 * What a key does inside the dialog, as data so a test can run it. Escape is
 * ignored while the request is in flight (the operator must not leave a write
 * half-watched) and closes the dialog once it has settled; Tab never leaves the
 * dialog: with nothing to focus it stays on the dialog itself.
 */
export function busyDialogKeyAction(input: {
  key: string; shiftKey: boolean; tone: AmuxBusyTone; focusableCount: number;
  /** Index of the focused control among the dialog's controls, -1 when the dialog itself has focus. */
  activeIndex: number;
}): { preventDefault: boolean; close: boolean; focusIndex: number | null } {
  if (input.key === "Escape") {
    return { preventDefault: true, close: input.tone !== "working", focusIndex: null };
  }
  if (input.key === "Tab") {
    if (input.focusableCount === 0) return { preventDefault: true, close: false, focusIndex: -1 };
    const last = input.focusableCount - 1;
    const focusIndex = input.shiftKey
      ? (input.activeIndex <= 0 ? last : input.activeIndex - 1)
      : (input.activeIndex < 0 || input.activeIndex >= last ? 0 : input.activeIndex + 1);
    return { preventDefault: true, close: false, focusIndex };
  }
  return { preventDefault: false, close: false, focusIndex: null };
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const TONE_CLASS: Record<AmuxBusyTone, string> = {
  working: "border-blue-500/30 bg-blue-500/10 text-blue-200",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  partial: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  refused: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  unknown: "border-red-500/30 bg-red-500/10 text-red-200",
};

/**
 * The dialog's markup, without hooks or a portal, so a test can render it. A
 * real modal: `role="dialog"` with `aria-modal`, named by its title and
 * described by its body; the wrapper moves focus in, traps it, makes the page
 * behind inert and ignores Escape while the write is in flight.
 */
export function AmuxIdeaBusyDialogView({ m, tone, title, message, elapsedSeconds, onClose, dialogRef, onKeyDown, children }: {
  m: Messages; tone: AmuxBusyTone; title: string;
  /** What is being recorded; shown while the request is in flight. */
  message?: string;
  elapsedSeconds: number;
  /** Absent while the request is in flight, and while a check inside the dialog is reading. */
  onClose?: () => void;
  dialogRef?: RefObject<HTMLDivElement | null>;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="amux-busy-dialog-backdrop">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="amux-busy-dialog-title"
        aria-describedby="amux-busy-dialog-body" tabIndex={-1} data-testid="amux-busy-dialog" data-tone={tone}
        onKeyDown={onKeyDown}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md space-y-3 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 text-sm text-zinc-100 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-blue-300">
        <h2 id="amux-busy-dialog-title" className="flex items-center gap-2 text-base font-semibold text-zinc-100">
          {tone === "working" ? <span aria-hidden="true"
            className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-blue-300 border-t-transparent" /> : null}
          {title}
        </h2>
        <div id="amux-busy-dialog-body" className="space-y-2 text-zinc-300">
          {tone === "working" ? <>
            {message ? <p>{message}</p> : null}
            <p className={`rounded-lg border p-3 ${TONE_CLASS.working}`} data-testid="amux-busy-dialog-warning">{m.busyWarn}</p>
            <p role="status" aria-live="polite" className="text-zinc-400" data-testid="amux-busy-dialog-elapsed">
              {m.busyElapsed(elapsedSeconds)}
            </p>
          </> : null}
          {children}
        </div>
        {tone !== "working" && onClose ? (
          <button type="button" onClick={onClose} data-testid="amux-busy-dialog-close"
            className="min-h-11 w-full rounded-lg border border-zinc-600 px-4 font-medium text-zinc-100 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300">
            {m.busyClose}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The blocking "working" dialog of a long AMUX Ideas write (plan approval,
 * execution approval, build preview). It opens when the request starts, shows
 * what is being recorded and how long it has run, cannot be dismissed while the
 * request is in flight, and turns into the answer (success, refusal or
 * unknown) when it settles; only then can it be closed. It never sends or
 * retries anything itself.
 */
export function AmuxIdeaBusyDialog({ open, tone, title, message, onClose, children }: {
  open: boolean; tone: AmuxBusyTone; title: string; message?: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Whole seconds since the working view opened, counted by its own timer (it starts at 0 each time).
  const [elapsed, setElapsed] = useState(0);
  const working = open && tone === "working";
  const toneRef = useRef(tone);
  useEffect(() => { toneRef.current = tone; }, [tone]);

  useEffect(() => {
    if (!working) return;
    const start = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1_000);
    return () => { window.clearInterval(timer); setElapsed(0); };
  }, [working]);

  // A write in flight must not be walked away from: the browser asks before a refresh or a close.
  useEffect(() => {
    if (!working) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [working]);

  // The page behind is inert and does not scroll; focus moves in and comes back when the dialog closes.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement ?? null;
    const inerted: Array<[Element, string | null]> = [];
    for (const element of Array.from(document.body.children)) {
      if (element === backdrop) continue;
      inerted.push([element, element.getAttribute("inert")]);
      element.setAttribute("inert", "");
    }
    const releaseScroll = lockBodyScroll();
    dialog?.focus();
    // Focus that escapes the dialog (a script, a screen reader) is brought back.
    const keepFocus = (event: FocusEvent) => {
      if (dialogRef.current && event.target instanceof Node && !dialogRef.current.contains(event.target)) {
        dialogRef.current.focus();
      }
    };
    // Escape is swallowed at the document while the write is in flight, whatever has focus.
    const swallowEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && toneRef.current === "working") { event.preventDefault(); event.stopPropagation(); }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", swallowEscape, true);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", swallowEscape, true);
      releaseScroll();
      for (const [element, value] of inerted) {
        if (value === null) element.removeAttribute("inert"); else element.setAttribute("inert", value);
      }
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  // When the answer replaces the working view, focus goes to its first control (or stays on the dialog).
  useEffect(() => {
    if (!open || tone === "working") return;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
  }, [open, tone]);

  if (!open || typeof document === "undefined") return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const action = busyDialogKeyAction({
      key: event.key, shiftKey: event.shiftKey, tone, focusableCount: controls.length,
      activeIndex: controls.indexOf(document.activeElement as HTMLElement),
    });
    if (action.preventDefault) { event.preventDefault(); event.stopPropagation(); }
    if (action.close) onClose?.();
    if (action.focusIndex !== null) (action.focusIndex < 0 ? dialog : controls[action.focusIndex])?.focus();
  };

  return createPortal(
    <AmuxIdeaBusyDialogView m={m} tone={tone} title={title} message={message}
      elapsedSeconds={elapsed}
      onClose={onClose} dialogRef={dialogRef} onKeyDown={onKeyDown}>
      {children}
    </AmuxIdeaBusyDialogView>,
    document.body,
  );
}
