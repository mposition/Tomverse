"use client";

import { useEffect, type RefObject } from "react";
import { lockBodyScroll } from "./useBodyScrollLock";

/**
 * UX-010. The focus contract every `aria-modal="true"` surface owes its users.
 *
 * `aria-modal="true"` is a promise to assistive technology that the rest of the
 * page is inert. Most of this app's modals declared it without keeping it: focus
 * stayed on the trigger behind the overlay, Tab walked the obscured page, and
 * nothing was announced on open. This is that contract, extracted verbatim from
 * the two surfaces that already implemented it correctly -- `UsageLimitModal`
 * and `CreditPackPurchaseButton` -- so the behaviour has one home instead of
 * being reimplemented per dialog.
 *
 * What it guarantees while `open`:
 *
 * - **Initial focus** moves into the dialog on the next frame (after the
 *   portal has painted), preferring `initialFocusRef` and falling back to the
 *   first focusable element in the panel -- unless another modal opened on top
 *   in the meantime, in which case the frame does nothing. A frame is long
 *   enough to open a nested dialog, and focus arriving late would drag the
 *   user back down into a dialog that is now inert, with no key press to
 *   explain it.
 * - **Tab and Shift+Tab cycle** within the panel, including when focus has
 *   escaped to the document.
 * - **Escape closes**, via `onClose`.
 * - **Background scroll is locked** through the shared reference-counted lock
 *   in `useBodyScrollLock`, never by writing `body.style.overflow` here. These
 *   dialogs stack -- Settings opens above the mobile drawer, Delete Account
 *   above Settings -- and a per-dialog save/restore gets both directions of
 *   that wrong: the outer surface releasing first unlocks the page underneath
 *   a dialog that is still open, and the inner one then restores the `hidden`
 *   it captured from the outer one, leaving the page unable to scroll with
 *   nothing open.
 * - **Focus returns** to whatever was focused before opening, if it is still in
 *   the document.
 * - **Nested modals own their own keys.** Ownership is decided by the event
 *   target's nearest `[role="dialog"][aria-modal="true"]` ancestor, not by DOM
 *   order: a portal can render before or after the dialog that opened it, so
 *   position is not a reliable signal. Escape inside a nested dialog must close
 *   that one, never the one underneath. The one exception is Tab arriving from
 *   an *underlying* aria-modal dialog while this dialog is topmost: initial
 *   focus lands a frame after open, so a fast Tab can still start from the
 *   trigger underneath, and the topmost dialog claims it rather than letting
 *   focus walk the inert dialog below.
 *
 * These are two effects on purpose, and the split is load-bearing.
 *
 * Everything above was one effect whose dependency list included `onClose`.
 * Callers write `onClose={() => setOpen(false)}`, a new function on every
 * render of the caller, so the whole effect tore down and rebuilt on each of
 * those renders -- and this effect's teardown *returns focus to the trigger*
 * while its setup *puts focus in the panel*. Two focus moves per parent
 * render, on a page that re-renders constantly.
 *
 * That is not a test artefact. `ComparisonReviewDialog` gets its `onClose`
 * from `ChatPageClient`, which re-renders on typing, streaming and model-status
 * polling; a keyboard user who focused the source-grounding info control was
 * thrown back to Close roughly 50ms later, having pressed nothing. It is the
 * same defect the nightly caught in `UsageLimitModal` and
 * `DeepResearchSetupSheet`, except here it sat in the hook all ten modal
 * surfaces share.
 *
 * So: focus and scroll lock key on `open` and the refs, never on a callback.
 * The key handlers keep `onClose` -- swapping a listener moves no focus, and
 * the Tab trap has to see the current one. `tests/modalFocusEffectDeps.test.mjs`
 * pins the split.
 */

/**
 * Whether another `aria-modal` dialog is later in document order.
 *
 * Only the key handlers ask this, and only as one half of the question:
 * document order is not stacking order, so a dialog can be last in the DOM and
 * underneath, or first and on top. `ownsEvent` survives that because it has a
 * second signal -- where the event came from -- to decide with. Nothing that
 * lacks that second signal may use this.
 *
 * A `null` dialog is not covered. The caller has no element to compare, which
 * is the un-mounted case, not the buried one.
 */
const laterInDocumentOrder = (dialog: HTMLElement | null) =>
  dialog !== null &&
  (Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
  ).at(-1) ?? null) !== dialog;

/**
 * The open modals, in the order they opened.
 *
 * The deferred initial focus needs to know whether something opened *on top of*
 * this dialog since its frame was scheduled, and two cheaper-looking signals
 * both answer a different question:
 *
 * - **Document order** is not stacking order. The mobile drawer stays mounted
 *   behind the model finder and renders after it, so the finder read itself as
 *   covered and never took focus at all.
 * - **Where focus currently is** is not it either. A nested dialog is opened by
 *   a trigger inside the dialog underneath, so at the moment the *new* dialog's
 *   frame fires, focus is legitimately still in the old one -- and skipping
 *   there leaves the new dialog with no focus.
 *
 * Open order is the thing itself, and nothing infers it: each dialog records
 * its own opening. `lastIndexOf` rather than `indexOf` because the same element
 * can be re-registered across a remount before the stale entry is removed.
 */
const openModals: HTMLElement[] = [];

/**
 * Records `dialog` as open and returns the matching removal. Exported for the
 * one modal surface that predates this hook and still runs its own focus frame,
 * the mobile drawer in `MobileChatShell`: a surface that does not register is
 * invisible to every other surface's guard.
 */
export const registerOpenModal = (dialog: HTMLElement) => {
  openModals.push(dialog);
  return () => {
    const index = openModals.lastIndexOf(dialog);
    if (index >= 0) openModals.splice(index, 1);
  };
};

/** Whether a modal opened after `dialog` and is still open. */
export const modalOpenedOnTop = (dialog: HTMLElement | null) => {
  if (!dialog) return false;
  const index = openModals.lastIndexOf(dialog);
  return index >= 0 && index < openModals.length - 1;
};

const focusableWithin = (panel: HTMLElement) =>
  Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    // `offsetParent === null` also covers `display: none` ancestors, which is
    // what a collapsed section inside an open dialog looks like.
  ).filter((element) => element.offsetParent !== null);

export function useModalDialog({
  open,
  onClose,
  dialogRef,
  panelRef,
  initialFocusRef,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  /** The element carrying `role="dialog"` and `aria-modal="true"`. */
  dialogRef: RefObject<HTMLElement | null>;
  /** The focusable region; usually the visible panel inside the overlay. */
  panelRef: RefObject<HTMLElement | null>;
  /** Preferred initial focus target. Falls back to the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Explicit trigger to restore when pointer activation does not move focus
   * (notably touch Safari). Falls back to the active element at open time.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return;

    const returnTarget =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const releaseScrollLock = lockBodyScroll();

    // Registered before the frame is scheduled, so a dialog that opens after
    // this one can be seen to have opened after it. The frame below is then
    // skipped when that happened: a frame is long enough for it -- Settings ->
    // Delete Account is two clicks -- and focus arriving late would pull the
    // person out of the dialog they are now in and back into this one, which
    // is inert, with no key press to explain it. Under CI load that is what
    // failed "Tab pressed before the nested dialog's initial focus lands" on
    // main at 11b98c9: the Tab was trapped correctly and this frame undid it.
    const unregister = dialogRef.current
      ? registerOpenModal(dialogRef.current)
      : null;
    const focusFrame = requestAnimationFrame(() => {
      if (modalOpenedOnTop(dialogRef.current)) return;
      const preferred = initialFocusRef?.current;
      if (preferred?.isConnected) {
        preferred.focus();
        return;
      }
      const panel = panelRef.current;
      if (!panel) return;
      focusableWithin(panel)[0]?.focus();
    });

    return () => {
      unregister?.();
      cancelAnimationFrame(focusFrame);
      releaseScrollLock();
      requestAnimationFrame(() => {
        // The trigger can be gone by now (a row that was just deleted, a menu
        // that closed with the dialog); focusing a detached node would silently
        // drop focus to <body>.
        if (!returnTarget?.isConnected) return;
        returnTarget.focus({ preventScroll: true });
        // WebKit can ignore the focus-options overload while a nested fixed
        // dialog is being removed. Retry with the baseline focus API so the
        // trigger contract is still kept on iOS/Safari.
        if (document.activeElement !== returnTarget) returnTarget.focus();
      });
    };
  }, [open, dialogRef, panelRef, initialFocusRef, returnFocusRef]);

  useEffect(() => {
    if (!open) return;

    const ownsEvent = (
      event: KeyboardEvent,
      options?: { claimUnderlyingDialogEvents?: boolean }
    ) => {
      const dialog = dialogRef.current;
      if (!dialog || !panelRef.current) return false;

      if (laterInDocumentOrder(dialog)) return false;

      const eventOwner =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[role="dialog"][aria-modal="true"]')
          : null;
      if (!eventOwner || eventOwner === dialog) return true;
      // The event began inside another aria-modal dialog. This dialog is the
      // topmost one, so that other dialog is underneath and inert; whether the
      // key still belongs to it depends on the key. Tab claims it (below):
      // focus can legitimately sit in the underlying dialog for the frame
      // between this dialog rendering and its initial focus landing, and a Tab
      // in that window must be trapped, not walk the inert dialog. Escape
      // declines it, preserving the nested-surface contract.
      return Boolean(options?.claimUnderlyingDialogEvents);
    };

    // Escape listens in the *bubble* phase on purpose. A dismissible surface
    // nested inside a dialog -- a popover, a combobox -- cancels itself on
    // Escape and calls `stopPropagation()` from a capture listener so the
    // dialog around it stays open (see SourceGroundingBadge). Listening in
    // capture here would beat that listener on registration order and close the
    // whole dialog instead, which is a silent loss of the user's place.
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ownsEvent(event)) return;
      event.preventDefault();
      onClose();
    };

    // Tab stays in capture: the trap has to run before any handler that might
    // move focus itself, or focus can leave the dialog for a frame.
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (
        event.key !== "Tab" ||
        !ownsEvent(event, { claimUnderlyingDialogEvents: true })
      )
        return;

      const focusable = focusableWithin(panel);
      if (focusable.length === 0) {
        // Nothing to cycle to; swallowing Tab keeps focus from escaping into
        // the inert background.
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose, dialogRef, panelRef]);
}
